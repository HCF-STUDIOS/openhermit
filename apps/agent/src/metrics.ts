import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Process-wide Prometheus registry. Agent runtime, channels (via the agent
 * runner's `user_message` publish path), and the gateway all share this
 * registry. The gateway exposes it at `/metrics`.
 */
export const metricsRegistry = new Registry();

let defaultMetricsStarted = false;

export const startDefaultMetrics = (): void => {
  if (defaultMetricsStarted) return;
  defaultMetricsStarted = true;
  collectDefaultMetrics({ register: metricsRegistry });
};

const PREFIX = 'openhermit_';

export const agentTurnsTotal = new Counter({
  name: `${PREFIX}agent_turns_total`,
  help: 'Total number of LLM turns completed.',
  labelNames: ['agent_id'] as const,
  registers: [metricsRegistry],
});

export const agentTurnDuration = new Histogram({
  name: `${PREFIX}agent_turn_duration_seconds`,
  help: 'Wall-clock duration of an LLM turn (prompt to agent_end).',
  labelNames: ['agent_id'] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

export const agentTokensTotal = new Counter({
  name: `${PREFIX}agent_tokens_total`,
  help: 'Total tokens consumed by agent turns.',
  labelNames: ['agent_id', 'direction'] as const,
  registers: [metricsRegistry],
});

export const agentToolCallsTotal = new Counter({
  name: `${PREFIX}agent_tool_calls_total`,
  help: 'Total tool calls issued by the agent.',
  labelNames: ['agent_id', 'tool'] as const,
  registers: [metricsRegistry],
});

export const agentErrorsTotal = new Counter({
  name: `${PREFIX}agent_errors_total`,
  help: 'Total agent errors.',
  labelNames: ['agent_id', 'source'] as const,
  registers: [metricsRegistry],
});

export const agentMessagesTotal = new Counter({
  name: `${PREFIX}agent_messages_total`,
  help: 'Total inbound user messages received by the agent (per source).',
  labelNames: ['agent_id', 'source'] as const,
  registers: [metricsRegistry],
});

// pdf-inspector's bindings are synchronous, so this duration is time the event
// loop was blocked, not just wall clock.
export const SLOW_PARSE_MS = 250;

export const pdfParseDurationMs = new Histogram({
  name: 'openhermit_pdf_parse_duration_ms',
  help: 'Event loop blocked by a synchronous pdf-inspector parse',
  buckets: [10, 50, 100, 250, 500, 1000],
  registers: [metricsRegistry],
});

export function recordPdfParse(ms: number): void {
  pdfParseDurationMs.observe(ms);
}
