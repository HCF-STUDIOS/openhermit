/**
 * Persistent SSE subscription helper for channel bridges. Per-turn loops read
 * the session events stream until `agent_end` then disconnect, so events the
 * server pushes after a turn (delayed media, a late error) are missed. This
 * keeps the same connect/resume/dedup loop open across turns and reconnects on
 * a transient drop. Transport-generic: forwards every non-transport frame to
 * `onEvent` as-is, knowing nothing about attachments or channels.
 */

export interface SseFrame {
  id?: number;
  event: string;
  data: string;
}

// Mirrors packages/sdk/src/sse.ts's parseSseFrames; duplicated because sdk
// already depends on shared, so importing back would be circular.
const parseSseFrames = (
  buffer: string,
): { frames: SseFrame[]; remainder: string } => {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const segments = normalized.split('\n\n');
  const remainder = segments.pop() ?? '';
  const frames: SseFrame[] = [];

  for (const segment of segments) {
    const lines = segment.split('\n');
    let event = 'message';
    let data = '';
    let id: number | undefined;

    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += `${line.slice(5).trim()}\n`;
      else if (line.startsWith('id:')) {
        const parsed = Number.parseInt(line.slice(3).trim(), 10);
        if (!Number.isNaN(parsed)) id = parsed;
      }
    }

    frames.push({
      ...(id !== undefined ? { id } : {}),
      event,
      data: data.replace(/\n$/, ''),
    });
  }

  return { frames, remainder };
};

export interface PersistentSubscriptionOptions {
  eventsUrl: string;
  /** Cursor to resume from. Frames with id <= this are skipped. */
  lastEventId?: number;
  headers?: Record<string, string>;
  onEvent: (frame: SseFrame) => void;
  /**
   * Fires when the cursor changes (new max id, or reset to 0 on sequence
   * rollover). Persist it beyond this subscription's lifetime so a later
   * call resumes via `lastEventId` instead of replaying the backlog.
   */
  onCursorAdvance?: (cursor: number) => void;
  abortSignal?: AbortSignal;
  /** Delay before reconnecting after a dropped stream. Default 2000ms. */
  reconnectDelayMs?: number;
  /**
   * Close an idle connection after this many ms with no real event (a frame
   * reaching `onEvent`), resolving without reconnecting so the caller can
   * reopen later. Reset per delivered event; keepalive pings do NOT reset it
   * (the gateway pings ~15s, which would pin every idle connection open).
   * Default 900000ms (15 min): covers a slow create job, releases quiet sessions.
   */
  idleTimeoutMs?: number;
}

const DEFAULT_RECONNECT_DELAY_MS = 2000;
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // The timer usually wins, so detach its own abort listener or one leaks per retry.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/**
 * Open `eventsUrl` as SSE and deliver events until `abortSignal` fires.
 * Resumes from `lastEventId`, dedupes by id, reconnects on transient drops.
 * Resolves without reconnecting once idle for `idleTimeoutMs` so the caller
 * can release the connection and reopen lazily.
 */
export async function startPersistentSubscription(
  options: PersistentSubscriptionOptions,
): Promise<void> {
  const { eventsUrl, onEvent, abortSignal, headers, onCursorAdvance } = options;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let cursor = options.lastEventId ?? 0;

  while (!abortSignal?.aborted) {
    let sequenceResetChecked = false;
    // Set when the idle timer fires: clean close resolves, transient drop reconnects.
    let idleClosed = false;

    try {
      const response = await fetch(eventsUrl, {
        ...(headers ? { headers } : {}),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      if (!response.ok || !response.body) {
        await sleep(reconnectDelayMs, abortSignal);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };
      // Arm/re-arm the idle timer. Cancelling the reader ends the read loop;
      // `idleClosed` then routes to a clean resolve, not a reconnect.
      const armIdle = (): void => {
        clearIdle();
        idleTimer = setTimeout(() => {
          idleClosed = true;
          void reader.cancel().catch(() => undefined);
        }, idleTimeoutMs);
        // Don't let an idle subscription hold the event loop open.
        idleTimer.unref?.();
      };
      abortSignal?.addEventListener('abort', clearIdle, { once: true });
      armIdle();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.remainder;

          for (const frame of parsed.frames) {
            if (frame.id !== undefined && frame.id <= cursor) continue;
            if (frame.id !== undefined) {
              cursor = frame.id;
              onCursorAdvance?.(cursor);
            }

            if (frame.event === 'ready') {
              // A new runner restarts ids at 1, so a stale cursor would skip every event: reset it.
              if (!sequenceResetChecked) {
                sequenceResetChecked = true;
                try {
                  const data = frame.data.length > 0
                    ? (JSON.parse(frame.data) as { nextEventId?: number })
                    : {};
                  if (typeof data.nextEventId === 'number' && data.nextEventId <= cursor) {
                    cursor = 0;
                    onCursorAdvance?.(cursor);
                  }
                } catch { /* ignore and fall back to stored cursor */ }
              }
              continue;
            }
            // Keepalive pings are not real activity: don't reset the idle timer.
            if (frame.event === 'ping') continue;

            // Real event: keep the connection alive.
            armIdle();
            onEvent(frame);
          }
        }
      } finally {
        clearIdle();
        abortSignal?.removeEventListener('abort', clearIdle);
        await reader.cancel().catch(() => undefined);
      }
    } catch {
      // Transient drop (network error, aborted read); fall through to reconnect unless shutting down.
    }

    if (abortSignal?.aborted) return;
    // Idle close is a clean end: resolve so the caller reopens lazily on the next message.
    if (idleClosed) return;
    await sleep(reconnectDelayMs, abortSignal);
  }
}
