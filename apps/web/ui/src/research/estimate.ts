/**
 * Rough wall-clock estimate for a research run, derived from its budget.
 * Calibrated against observed runs (~20–40 s per loop iteration); the
 * elapsed-time budget is the hard ceiling. Approximate by design — always
 * surfaced with a "~" so it never reads as a promise.
 */

export interface ResearchTimeEstimate {
  lowMinutes: number;
  highMinutes: number;
}

const SECONDS_PER_ITERATION_LOW = 20;
const SECONDS_PER_ITERATION_HIGH = 40;

export const estimateResearchMinutes = (
  budget: Record<string, number> | undefined,
): ResearchTimeEstimate | null => {
  const iterations = budget?.iterations;
  if (!iterations || iterations <= 0) return null;
  const capMinutes = budget?.elapsedMs ? budget.elapsedMs / 60_000 : null;
  const low = Math.max(1, Math.round((iterations * SECONDS_PER_ITERATION_LOW) / 60));
  let high = Math.max(low, Math.ceil((iterations * SECONDS_PER_ITERATION_HIGH) / 60));
  if (capMinutes !== null) high = Math.min(high, Math.max(1, Math.floor(capMinutes)));
  return { lowMinutes: Math.min(low, high), highMinutes: high };
};
