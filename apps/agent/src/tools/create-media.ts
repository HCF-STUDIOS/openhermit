import { gatewayRoutes } from '@openhermit/protocol';

import { asTextContent, formatJson, type ToolContext } from './shared.js';

export type CreateMediaMode = 'IMAGE' | 'VIDEO' | 'TTS' | 'SFX' | 'MUSIC';

export interface SubmitCreateJobInput {
  mode: CreateMediaMode;
  /** Mode-specific create body, WITHOUT twinId — the twin token binds it server-side. */
  jobBody: Record<string, unknown>;
  /** amiko-web base URL, e.g. from the `AMIKO_PLATFORM_URL` per-agent secret. */
  baseUrl: string;
  /** `clawd-`-prefixed twin JWT, e.g. from the `AMIKO_TWIN_TOKEN` per-agent secret. */
  twinToken: string;
}

export interface SubmitCreateJobDeps {
  fetch?: typeof fetch;
}

export interface SubmitCreateJobDetails {
  jobId?: string;
  mode: CreateMediaMode;
  error?: string;
}

export interface SubmitCreateJobResult {
  content: ReturnType<typeof asTextContent>;
  details: SubmitCreateJobDetails;
}

const errorResult = (
  mode: CreateMediaMode,
  message: string,
  error: string,
): SubmitCreateJobResult => ({
  content: asTextContent(`${message}\n`),
  details: { mode, error },
});

/**
 * Submits a create job to amiko-web as the twin, emits a `pending_media`
 * event so a skeleton renders in the live conversation, and returns a
 * compact `{jobId, status}` result to the model. Non-blocking — this does
 * NOT poll to completion; resolution is client-driven later.
 *
 * Kept pure of secret resolution: `baseUrl`/`twinToken` are explicit inputs
 * so the tool factory (which reads `security.resolveSecrets(...)`) stays the
 * only place that touches secret storage, and this helper is trivially
 * unit-testable.
 */
export async function submitCreateJob(
  context: ToolContext,
  input: SubmitCreateJobInput,
  deps: SubmitCreateJobDeps = {},
): Promise<SubmitCreateJobResult> {
  const { mode, jobBody, baseUrl, twinToken } = input;
  const doFetch = deps.fetch ?? fetch;

  if (!baseUrl || !twinToken) {
    return errorResult(
      mode,
      `Unable to submit ${mode} create job: twin credentials are not configured.`,
      'missing_credentials',
    );
  }

  const url = `${baseUrl}${gatewayRoutes.agentCreateSubmit()}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${twinToken}`,
      },
      body: JSON.stringify(jobBody),
    });
  } catch (err) {
    return errorResult(
      mode,
      `Failed to submit ${mode} create job: ${err instanceof Error ? err.message : String(err)}`,
      'network_error',
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return errorResult(
      mode,
      `Failed to submit ${mode} create job: server responded ${response.status}${detail ? ` — ${detail}` : ''}`,
      `http_${response.status}`,
    );
  }

  const data = (await response.json()) as { jobId: string };
  const jobId = data.jobId;

  if (context.publishEvent && context.sessionId) {
    context.publishEvent({
      type: 'pending_media',
      sessionId: context.sessionId,
      jobId,
      mode,
    });
  }

  if (context.messageStore && context.storeScope && context.sessionId) {
    await context.messageStore.appendLogEntry(context.storeScope, context.sessionId, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content: '',
      metadata: {
        source: 'create_media',
        mode,
        jobId,
      },
    });
  }

  return {
    content: asTextContent(formatJson({ jobId, status: 'queued', mode })),
    details: { jobId, mode },
  };
}
