/**
 * Shared persistent SSE subscription helper for channel bridges.
 *
 * The gateway's session events endpoint never closes on its own and replays
 * the full recent backlog on every new connection. Callers dedupe by
 * comparing each frame's id against the highest id already seen. Per-turn
 * bridge loops open this stream and read until `agent_end` then disconnect.
 * So events the server pushes after a turn ends are never read. A delayed
 * media attachment or a late error gets missed. This helper keeps the same
 * connect/resume/dedup loop open across turns and reconnects on a transient
 * drop so out-of-turn events still get delivered. It is transport-generic.
 * It forwards every non-transport frame to `onEvent` as-is and knows nothing
 * about media attachments or any particular channel.
 */

export interface SseFrame {
  id?: number;
  event: string;
  data: string;
}

// Mirrors packages/sdk/src/sse.ts's parseSseFrames. Duplicated not imported.
// @openhermit/sdk already depends on @openhermit/shared so importing the
// other way would be circular.
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
   * Called whenever the internal cursor changes. A new max id seen or a reset
   * to 0 on detected sequence rollover. Callers persist the cursor somewhere
   * that survives this subscription being torn down such as on idle close.
   * A later `startPersistentSubscription` call for the same logical session
   * then resumes via `lastEventId` instead of re-reading the backlog and
   * re-delivering old events.
   */
  onCursorAdvance?: (cursor: number) => void;
  abortSignal?: AbortSignal;
  /** Delay before reconnecting after a dropped stream. Default 2000ms. */
  reconnectDelayMs?: number;
  /**
   * Bound the lifetime of an otherwise-idle connection. If no real event
   * arrives within this many ms the stream is closed and the subscription
   * RESOLVES without reconnecting so a caller can drop it and reopen later.
   * A real event is a frame that reaches `onEvent`. Reset on every delivered
   * event so an in-flight job keeps its connection alive. Keepalive pings do
   * NOT reset it. The gateway pings every ~15s so counting pings would keep
   * every idle connection open forever. Default 900000 ms which is 15 min.
   * It covers a slow create job while still releasing quiet sessions.
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
    // The timer wins on every reconnect where nothing aborts so it must
    // detach its own abort listener. Otherwise one accumulates per retry
    // for the lifetime of the subscription.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/**
 * Open `eventsUrl` as an SSE stream and keep delivering events until
 * `abortSignal` fires. Resumes from `lastEventId` and dedupes by id the
 * same way the existing per-turn bridge loops do. Reconnects after a
 * transient drop instead of ending the subscription. Closes and resolves
 * without reconnecting once no real event has arrived for `idleTimeoutMs`
 * so a caller can release the connection and reopen lazily later.
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
    // Set when the idle timer fires so we can distinguish a clean idle close
    // from a transient drop. Clean close resolves. Transient drop reconnects.
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
      // Arm or re-arm the idle timer. Cancelling the reader unblocks the
      // pending read which ends the loop. `idleClosed` then routes us to a
      // clean resolve instead of a reconnect.
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
              // Detect sequence reset. A new runner restarts ids at 1 so a
              // stored cursor from a previous runner would skip every event.
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
            // Keepalive pings keep the socket warm but are not real activity
            // so they must not reset the idle timer.
            if (frame.event === 'ping') continue;

            // A real event. The connection is doing useful work so keep it.
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
      // Transient drop such as a network error or aborted read. Fall
      // through to reconnect below unless shutdown was requested.
    }

    if (abortSignal?.aborted) return;
    // Idle close is a deliberate clean end. Resolve so the caller can drop
    // this subscription and reopen lazily on the next message.
    if (idleClosed) return;
    await sleep(reconnectDelayMs, abortSignal);
  }
}
