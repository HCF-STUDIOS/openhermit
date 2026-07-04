import { Type, type Static } from '@mariozechner/pi-ai';
import { gatewayRoutes } from '@openhermit/protocol';

import {
  asTextContent,
  formatJson,
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
} from './shared.js';

export type CreateMediaMode = 'IMAGE' | 'VIDEO' | 'TTS' | 'SFX' | 'MUSIC';

export interface SubmitCreateJobInput {
  mode: CreateMediaMode;
  /** Mode-specific create body. `twinId` is merged in automatically from the field below. */
  jobBody: Record<string, unknown>;
  /** amiko-web base URL, e.g. from the `AMIKO_PLATFORM_URL` per-agent secret. */
  baseUrl: string;
  /** `clawd-`-prefixed twin JWT, e.g. from the `AMIKO_TWIN_TOKEN` per-agent secret. */
  twinToken: string;
  /**
   * Twin id, e.g. from the `AMIKO_TWIN_ID` per-agent secret. amiko-web's
   * `bodySchema` in api/create/jobs/route.ts requires `twinId` unconditionally
   * in every mode branch, since twin-token auth only affects ownership, not
   * body validation, so it must be sent explicitly on every request.
   */
  twinId: string;
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
 * compact `{jobId, status}` result to the model. Non-blocking, this does
 * NOT poll to completion; resolution is client-driven later.
 *
 * Kept pure of secret resolution: `baseUrl`/`twinToken` are explicit inputs
 * so the tool factory, which reads `security.resolveSecrets(...)`, stays
 * the only place that touches secret storage, and this helper is trivially
 * unit-testable.
 */
export async function submitCreateJob(
  context: ToolContext,
  input: SubmitCreateJobInput,
  deps: SubmitCreateJobDeps = {},
): Promise<SubmitCreateJobResult> {
  const { mode, jobBody, baseUrl, twinToken, twinId } = input;
  const doFetch = deps.fetch ?? fetch;

  if (!baseUrl || !twinToken || !twinId) {
    return errorResult(
      mode,
      `Unable to submit ${mode} create job: twin credentials are not configured.`,
      'missing_credentials',
    );
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${gatewayRoutes.agentCreateSubmit()}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${twinToken}`,
      },
      body: JSON.stringify({ ...jobBody, twinId }),
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

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    return errorResult(
      mode,
      `Failed to submit ${mode} create job: server returned an unreadable response (${err instanceof Error ? err.message : String(err)})`,
      'bad_response',
    );
  }

  const jobId = (data as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    return errorResult(
      mode,
      `Failed to submit ${mode} create job: server response did not include a job id.`,
      'bad_response',
    );
  }

  if (context.publishEvent && context.sessionId) {
    context.publishEvent({
      type: 'pending_media',
      sessionId: context.sessionId,
      jobId,
      mode,
    });
  }

  if (context.messageStore && context.storeScope && context.sessionId) {
    try {
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
    } catch (err) {
      console.error(`create_media: failed to persist log entry for ${mode} job ${jobId}:`, err);
    }
  }

  return {
    content: asTextContent(formatJson({ jobId, status: 'queued', mode })),
    details: { jobId, mode },
  };
}

/**
 * Resolves the twin's amiko-web credentials for `submitCreateJob`.
 * `security.resolveSecrets` throws when a requested secret is missing,
 * caught here so tools degrade to `submitCreateJob`'s honest
 * `missing_credentials` error instead of throwing out of `execute`.
 */
const resolveTwinCreds = (
  security: ToolContext['security'],
): { baseUrl: string; twinToken: string; twinId: string } => {
  try {
    const resolved = security.resolveSecrets([
      'AMIKO_PLATFORM_URL',
      'AMIKO_TWIN_TOKEN',
      'AMIKO_TWIN_ID',
    ]);
    return {
      baseUrl: resolved.AMIKO_PLATFORM_URL ?? '',
      twinToken: resolved.AMIKO_TWIN_TOKEN ?? '',
      twinId: resolved.AMIKO_TWIN_ID ?? '',
    };
  } catch {
    return { baseUrl: '', twinToken: '', twinId: '' };
  }
};

const CREATE_MEDIA_POLICY = { defaultGrants: [{ type: 'role' as const, value: 'owner' as const }] };

const CreateImageParams = Type.Object({
  prompt: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: 'Text description of the image to generate.',
  }),
  model: Type.String({ minLength: 1, description: 'Image model identifier to generate with.' }),
  size: Type.Union(
    [
      Type.Literal('1:1'),
      Type.Literal('16:9'),
      Type.Literal('9:16'),
      Type.Literal('4:3'),
      Type.Literal('3:4'),
    ],
    { description: 'Output image aspect ratio.' },
  ),
});
type CreateImageArgs = Static<typeof CreateImageParams>;

export const createImageTool = (
  context: ToolContext,
  deps: SubmitCreateJobDeps = {},
): PolicyAwareTool<typeof CreateImageParams> => ({
  policy: CREATE_MEDIA_POLICY,
  name: 'create_image',
  label: 'Create Image',
  description:
    'Generate an image from a text prompt for the user. This is the ONLY real way to create images — it is not a placeholder or simulation. Submission is asynchronous: it posts a pending-media placeholder that resolves into a viewable image in the chat once generation completes. The twin\'s wallet is charged only on success.',
  parameters: CreateImageParams,
  execute: async (_toolCallId, args: CreateImageArgs) => {
    const { baseUrl, twinToken, twinId } = resolveTwinCreds(context.security);
    return submitCreateJob(
      context,
      {
        mode: 'IMAGE',
        jobBody: { mode: 'IMAGE', prompt: args.prompt, model: args.model, size: args.size },
        baseUrl,
        twinToken,
        twinId,
      },
      deps,
    );
  },
});

const CreateVideoParams = Type.Object({
  prompt: Type.Optional(
    Type.String({
      maxLength: 2000,
      description: 'Text description of the video. Required for text-to-video; optional when firstFrameImage is supplied.',
    }),
  ),
  model: Type.String({ minLength: 1, description: 'Video model identifier to generate with.' }),
  resolution: Type.Optional(
    Type.Union(
      [
        Type.Literal('512P'),
        Type.Literal('720P'),
        Type.Literal('768P'),
        Type.Literal('1080P'),
      ],
      { description: 'Output video resolution. Defaults to "768P".' },
    ),
  ),
  seconds: Type.Optional(
    Type.Union([Type.Literal(6), Type.Literal(10)], {
      description: 'Video length in seconds, 6 or 10. Defaults to 6.',
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({ description: 'Output aspect ratio, e.g. "16:9".' }),
  ),
  firstFrameImage: Type.Optional(
    Type.String({ description: 'Image-to-video: URL or base64 data URI of the first frame.' }),
  ),
});
type CreateVideoArgs = Static<typeof CreateVideoParams>;

export const createVideoTool = (
  context: ToolContext,
  deps: SubmitCreateJobDeps = {},
): PolicyAwareTool<typeof CreateVideoParams> => ({
  policy: CREATE_MEDIA_POLICY,
  name: 'create_video',
  label: 'Create Video',
  description:
    'Generate a video clip for the user. This is the ONLY real way to create videos — it is not a placeholder or simulation. Submission is asynchronous: it posts a pending-media placeholder that resolves into a playable video in the chat once generation completes. The twin\'s wallet is charged only on success.',
  parameters: CreateVideoParams,
  execute: async (_toolCallId, args: CreateVideoArgs) => {
    const { baseUrl, twinToken, twinId } = resolveTwinCreds(context.security);
    return submitCreateJob(
      context,
      {
        mode: 'VIDEO',
        jobBody: {
          mode: 'VIDEO',
          prompt: args.prompt,
          model: args.model,
          resolution: args.resolution ?? '768P',
          seconds: args.seconds ?? 6,
          aspectRatio: args.aspectRatio,
          firstFrameImage: args.firstFrameImage,
        },
        baseUrl,
        twinToken,
        twinId,
      },
      deps,
    );
  },
});

const CreateTtsParams = Type.Object({
  prompt: Type.String({
    minLength: 1,
    maxLength: 5000,
    description: 'Text to speak.',
  }),
  model: Type.String({ minLength: 1, description: 'TTS model identifier to generate with.' }),
  voiceId: Type.String({ description: 'Voice identifier to speak with.' }),
});
type CreateTtsArgs = Static<typeof CreateTtsParams>;

export const createTtsTool = (
  context: ToolContext,
  deps: SubmitCreateJobDeps = {},
): PolicyAwareTool<typeof CreateTtsParams> => ({
  policy: CREATE_MEDIA_POLICY,
  name: 'create_tts',
  label: 'Create Text-to-Speech',
  description:
    'Generate spoken audio from text in a specific voice for the user. This is the ONLY real way to create speech audio — it is not a placeholder or simulation. Submission is asynchronous: it posts a pending-media placeholder that resolves into playable audio in the chat once generation completes. The twin\'s wallet is charged only on success.',
  parameters: CreateTtsParams,
  execute: async (_toolCallId, args: CreateTtsArgs) => {
    const { baseUrl, twinToken, twinId } = resolveTwinCreds(context.security);
    return submitCreateJob(
      context,
      {
        mode: 'TTS',
        jobBody: { mode: 'TTS', prompt: args.prompt, model: args.model, voiceId: args.voiceId },
        baseUrl,
        twinToken,
        twinId,
      },
      deps,
    );
  },
});

const CreateSfxParams = Type.Object({
  prompt: Type.String({
    minLength: 1,
    maxLength: 500,
    description: 'Text description of the sound effect to generate.',
  }),
  durationSeconds: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, description: 'Desired sound effect length in seconds.' }),
  ),
});
type CreateSfxArgs = Static<typeof CreateSfxParams>;

export const createSfxTool = (
  context: ToolContext,
  deps: SubmitCreateJobDeps = {},
): PolicyAwareTool<typeof CreateSfxParams> => ({
  policy: CREATE_MEDIA_POLICY,
  name: 'create_sfx',
  label: 'Create Sound Effect',
  description:
    'Generate a short sound effect from a text description for the user. This is the ONLY real way to create sound effects — it is not a placeholder or simulation. Submission is asynchronous: it posts a pending-media placeholder that resolves into playable audio in the chat once generation completes. The twin\'s wallet is charged only on success.',
  parameters: CreateSfxParams,
  execute: async (_toolCallId, args: CreateSfxArgs) => {
    const { baseUrl, twinToken, twinId } = resolveTwinCreds(context.security);
    return submitCreateJob(
      context,
      {
        mode: 'SFX',
        jobBody: { mode: 'SFX', prompt: args.prompt, durationSeconds: args.durationSeconds },
        baseUrl,
        twinToken,
        twinId,
      },
      deps,
    );
  },
});

const CreateMusicParams = Type.Object({
  prompt: Type.Optional(
    Type.String({
      maxLength: 2000,
      description: 'Description or theme of the song. Optional in cover mode.',
    }),
  ),
  model: Type.Optional(
    Type.String({ minLength: 1, description: 'Music model identifier. Defaults to "music-2.6".' }),
  ),
  lyrics: Type.Optional(
    Type.String({ maxLength: 3500, description: 'Lyrics for the song.' }),
  ),
  durationMs: Type.Optional(
    Type.Integer({
      exclusiveMinimum: 0,
      description: 'Desired track length in milliseconds (integer).',
    }),
  ),
  isInstrumental: Type.Optional(
    Type.Boolean({ description: 'Whether to generate an instrumental track with no vocals.' }),
  ),
});
type CreateMusicArgs = Static<typeof CreateMusicParams>;

export const createMusicTool = (
  context: ToolContext,
  deps: SubmitCreateJobDeps = {},
): PolicyAwareTool<typeof CreateMusicParams> => ({
  policy: CREATE_MEDIA_POLICY,
  name: 'create_music',
  label: 'Create Music',
  description:
    'Generate a song/music track for the user. Async — posts a placeholder that resolves to playable audio in the chat. The twin\'s wallet is charged on success. This is the ONLY real way to create music — it is not a placeholder or simulation.',
  parameters: CreateMusicParams,
  execute: async (_toolCallId, args: CreateMusicArgs) => {
    const { baseUrl, twinToken, twinId } = resolveTwinCreds(context.security);
    return submitCreateJob(
      context,
      {
        mode: 'MUSIC',
        jobBody: {
          mode: 'MUSIC',
          prompt: args.prompt,
          model: args.model ?? 'music-2.6',
          lyrics: args.lyrics,
          durationMs: args.durationMs,
          isInstrumental: args.isInstrumental,
        },
        baseUrl,
        twinToken,
        twinId,
      },
      deps,
    );
  },
});

export const createMediaToolset = (
  context: ToolContext,
  deps: SubmitCreateJobDeps = {},
): Toolset => ({
  id: 'create_media',
  description: 'Generate images, video, speech, sound effects, and music for the user.',
  tools: [
    createImageTool(context, deps),
    createVideoTool(context, deps),
    createTtsTool(context, deps),
    createSfxTool(context, deps),
    createMusicTool(context, deps),
  ],
});
