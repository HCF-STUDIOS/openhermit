import { Cron } from 'croner';
import type { ScheduleRecord, ScheduleStatus, ScheduleStore } from '@openhermit/store';

import type { AgentInstanceManager } from './agent-instance.js';

const TICK_INTERVAL_MS = 10_000;
const BACKOFF_STEPS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export interface CentralSchedulerOptions {
  /** Receives runtime warnings (invalid cron, persistence failures, ...). */
  log?: (message: string) => void;
  /** Override tick interval in tests. */
  tickIntervalMs?: number;
}

/**
 * Gateway-level scheduler that scans the `schedules` table across all
 * agents, hydrates the agent runner on demand, and fires due schedules.
 * Replaces the per-runner Scheduler — the in-memory runner Map is just a
 * hydration cache, so any per-runner timer would be lost on eviction.
 *
 * Precision: tick-based polling at `tickIntervalMs` (default 10s). Cron
 * fire times can drift by up to one tick interval. For sub-second
 * precision, run the tick more frequently or layer in-process timers.
 */
export class CentralScheduler {
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private running = new Set<string>();
  private stopped = false;
  private readonly log: (message: string) => void;
  private readonly tickIntervalMs: number;

  constructor(
    private readonly store: ScheduleStore,
    private readonly instances: AgentInstanceManager,
    options: CentralSchedulerOptions = {},
  ) {
    this.log = options.log ?? (() => {});
    this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
  }

  start(): void {
    this.stopped = false;
    // Fire one tick immediately so overdue jobs after a restart don't
    // wait an extra interval before catching up.
    void this.tick();
    this.tickTimer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  /** Exposed for tests. */
  async tick(): Promise<void> {
    if (this.stopped) return;

    // 1. Bootstrap any active cron schedules with NULL next_run_at —
    //    these are newly created or had their cron expression changed.
    try {
      const orphans = await this.store.listAllOrphanedCron();
      for (const schedule of orphans) {
        await this.bootstrapCron(schedule);
      }
    } catch (err) {
      this.log(`central scheduler: listAllOrphanedCron failed: ${describe(err)}`);
    }

    // 2. Fire any active schedule whose next_run_at has elapsed.
    let due: ScheduleRecord[];
    try {
      due = await this.store.listAllDue(new Date().toISOString());
    } catch (err) {
      this.log(`central scheduler: listAllDue failed: ${describe(err)}`);
      return;
    }

    for (const schedule of due) {
      void this.executeJob(schedule);
    }
  }

  private async bootstrapCron(schedule: ScheduleRecord): Promise<void> {
    if (!schedule.cronExpression) return;
    const scope = { agentId: schedule.agentId };
    const key = `${schedule.agentId}/${schedule.scheduleId}`;
    try {
      const job = new Cron(schedule.cronExpression, { timezone: 'UTC' });
      const next = job.nextRun();
      if (next) {
        await this.store.setNextRun(scope, schedule.scheduleId, next.toISOString());
      } else {
        // Valid syntax but no future fire (e.g. cron with a fixed past
        // date). Park the row so listAllOrphanedCron stops returning it.
        this.log(`schedule ${key}: cron "${schedule.cronExpression}" yields no next run; marking failed`);
        await this.store.update(scope, schedule.scheduleId, { status: 'failed' as ScheduleStatus })
          .catch((err) => this.log(`schedule ${key}: park-failed update failed: ${describe(err)}`));
      }
    } catch (err) {
      this.log(`schedule ${key}: invalid cron "${schedule.cronExpression}": ${describe(err)}`);
      // Park the row in 'failed' so we don't re-scan it every tick.
      // markRun records the error message; update flips status.
      await this.store.markRun(scope, schedule.scheduleId, null, `invalid cron expression: ${describe(err)}`)
        .catch((markErr) => this.log(`schedule ${key}: markRun(invalid) failed: ${describe(markErr)}`));
      await this.store.update(scope, schedule.scheduleId, { status: 'failed' as ScheduleStatus })
        .catch((updErr) => this.log(`schedule ${key}: park-invalid update failed: ${describe(updErr)}`));
    }
  }

  private async executeJob(schedule: ScheduleRecord): Promise<void> {
    if (this.stopped) return;

    const key = `${schedule.agentId}:${schedule.scheduleId}`;
    // Single-flight per (agentId, scheduleId). Claim synchronously.
    if (this.running.has(key)) return;
    this.running.add(key);

    const scope = { agentId: schedule.agentId };

    try {
      // Re-fetch in case the row changed between listAllDue and now.
      const fresh = await this.store.get(scope, schedule.scheduleId);
      if (!fresh || fresh.status !== 'active') return;

      let runner;
      try {
        runner = await this.instances.getOrHydrate(schedule.agentId);
      } catch (err) {
        this.log(`schedule ${key}: hydrate failed: ${describe(err)}`);
        await this.store.markRun(scope, schedule.scheduleId, this.computeNextOnError(fresh), `hydrate failed: ${describe(err)}`)
          .catch((markErr) => this.log(`schedule ${key}: markRun(hydrate-fail) failed: ${describe(markErr)}`));
        return;
      }

      if (!runner) {
        // Agent missing or disabled. Push next_run_at forward 5 min so
        // we don't busy-poll the row every tick; the schedule resumes
        // when the agent is enabled again.
        this.log(`schedule ${key}: agent unavailable (missing or disabled), backing off 5m`);
        const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
        await this.store.setNextRun(scope, schedule.scheduleId, retryAt)
          .catch((err) => this.log(`schedule ${key}: setNextRun(unavailable) failed: ${describe(err)}`));
        return;
      }

      const sessionId = `schedule:${fresh.scheduleId}`;
      const run = await this.store.startRun(scope, fresh.scheduleId, sessionId, fresh.prompt);

      try {
        await this.instances.withBusy(schedule.agentId, () => runner.runScheduledJob(fresh, sessionId));

        const nextRunAt = this.computeNextOnSuccess(fresh);
        await this.store.markRun(scope, fresh.scheduleId, nextRunAt);
        await this.store.finishRun(scope, run.id, 'completed');

        if (fresh.type === 'once') {
          await this.store.update(scope, fresh.scheduleId, { status: 'completed' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`schedule ${key} run ${run.id}: failed: ${message}`);

        await this.store.finishRun(scope, run.id, 'failed', message)
          .catch((err) => this.log(`schedule ${key} run ${run.id}: finishRun failed: ${describe(err)}`));

        const nextRunAt = this.computeNextOnError(fresh);
        await this.store.markRun(scope, fresh.scheduleId, nextRunAt, message)
          .catch((err) => this.log(`schedule ${key}: markRun(failed) failed: ${describe(err)}`));
      }
    } catch (err) {
      this.log(`schedule ${key}: setup failed: ${describe(err)}`);
    } finally {
      this.running.delete(key);
    }
  }

  private computeNextOnSuccess(schedule: ScheduleRecord): string | null {
    if (schedule.type !== 'cron' || !schedule.cronExpression) return null;
    try {
      const job = new Cron(schedule.cronExpression, { timezone: 'UTC' });
      const next = job.nextRun();
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }

  private computeNextOnError(schedule: ScheduleRecord): string | null {
    if (schedule.type !== 'cron' || !schedule.cronExpression) return null;
    const backoffMs = BACKOFF_STEPS[Math.min(schedule.consecutiveErrors, BACKOFF_STEPS.length - 1)]!;
    let naturalNext = 0;
    try {
      const job = new Cron(schedule.cronExpression, { timezone: 'UTC' });
      naturalNext = job.nextRun()?.getTime() ?? 0;
    } catch {
      // fall through
    }
    const backoffNext = Date.now() + backoffMs;
    return new Date(Math.max(naturalNext, backoffNext)).toISOString();
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
