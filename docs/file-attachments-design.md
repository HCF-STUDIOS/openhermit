# File Attachments Design

This document describes how OpenHermit handles non-text input: user-uploaded
files made available to agents in a controlled, durable, and tool-friendly way.

The goal is not to send every uploaded file directly to a multimodal model.
Instead, files become first-class resources with two access paths:

1. A durable storage reference for gateway-side and external tools.
2. An optional sandbox path that agent shell commands and filesystem tools can read.

This gives text-only models a practical way to work with PDFs, spreadsheets,
archives, source bundles, and other documents through tools. It also creates the
same foundation needed for image, audio, and video inputs.

## Implementation Status

Phase 1 (file availability) has shipped. Phase 2 (multimodal routing) is
partially in place — image inlining for multimodal-capable models is live;
`attachment_url` and broader audio/video routing remain deferred. The
"Description Generation" extractor is unimplemented and tracked as a future
phase rather than part of Phase 1.

## Goals

- Let users attach files to session messages.
- Persist uploaded bytes in a storage backend such as local disk, S3, or
  Supabase Storage.
- Materialize eligible files into the agent sandbox so `exec`, `file_read`, and
  other in-sandbox tools can inspect them directly.
- Keep large files out of the sandbox by default while still giving tools a
  controlled way to obtain a signed URL or fetch the file on demand.
- Keep attachment metadata durable, auditable, and scoped to an agent/session.
- Avoid storing large file bytes in PostgreSQL or in session event payloads.

## Non-Goals

- Full multimodal model routing in the first implementation.
- Full document parsing in the upload path. Extraction should be handled by
  explicit tools, not hidden preprocessing.
- Permanent public URLs. External storage URLs should be signed on demand when
  possible.
- Legacy compatibility for arbitrary `attachments.data` payloads. New uploads
  should use attachment IDs and storage references.

## Current State

The protocol carries attachment metadata on session messages and the gateway
preserves it in session events. As of Phase 1:

- `POST /api/agents/:agentId/sessions/:sessionId/attachments` accepts multipart
  uploads and persists durable rows.
- An `AttachmentStorage` abstraction is in place with `local`, `s3`, and
  `supabase` providers.
- Sandbox materialization copies eligible files into the active backend.
- `createUserMessage` renders an attachment list into model context.
- `attachment_list` and `attachment_fetch` tools are wired up.
- Image inlining for multimodal-capable models is live (Phase 2 partial).

Still outstanding:

- server-side description extraction (see "Description Generation").
- `attachment_url` signed-URL tool (Phase 2).
- broader multimodal routing for audio/video.

## Data Model

Add an `attachments` table. The exact column names can follow the store naming
style, but the conceptual model should be:

| Field | Purpose |
|-------|---------|
| `id` | Stable attachment ID used in messages and tools |
| `agent_id` | Agent scope |
| `session_id` | Session scope |
| `uploader_user_id` | User who uploaded the file, when known |
| `original_name` | Original client filename for display |
| `safe_name` | Sanitized filename used in sandbox paths |
| `mime_type` | Client or server-detected MIME type |
| `size_bytes` | File size |
| `sha256` | Content hash for integrity and dedup/debugging |
| `storage_provider` | `local`, `s3`, `supabase`, or future providers |
| `storage_key` | Provider-internal object key |
| `sandbox_id` | Sandbox/backend that currently has a materialized copy, if any |
| `sandbox_path` | Agent-visible path, if materialized |
| `materialization_state` | `pending`, `copied`, or `failed` |
| `materialization_error` | Last copy/fetch error, if any |
| `created_at` | Creation timestamp |

> Description/extraction fields (`description`, `description_state`) are
> intentionally not on the row in the shipped schema — see "Description
> Generation" below for the deferred design.

Session events should reference attachments by ID and include display metadata
only. Large bytes and long-lived storage URLs must stay out of `session_events`.

Shipped message attachment shape (`@openhermit/protocol`):

```ts
interface SessionAttachment {
  id?: string;
  type: string;
  name?: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  sandboxPath?: string;
  materializationState?: 'pending' | 'copied' | 'failed';
  /** URL-passthrough input: gateway fetches and persists into
   *  `session_attachments` on receive, then injects the resolved
   *  attachment into the current turn. Mutually exclusive with `id`. */
  url?: string;
  /** Legacy: inline base64 payload, kept for back-compat. */
  data?: string;
}
```

The attachment ID is the authority once resolved. `sandboxPath` is a convenience
for the model and may become stale if a sandbox is rebuilt. The `url` field
covers the channel-adapter case (remote media linked into a message); the
gateway resolves it into a durable attachment row on receive.

## Storage Abstraction

Introduce an attachment storage provider interface:

```ts
interface AttachmentStorage {
  put(input: {
    agentId: string;
    sessionId: string;
    attachmentId: string;
    filename: string;
    contentType: string;
    body: NodeJS.ReadableStream;
  }): Promise<{ storageKey: string }>;

  readStream(storageKey: string): Promise<NodeJS.ReadableStream>;

  getSignedUrl(
    storageKey: string,
    options: { expiresInSeconds: number },
  ): Promise<string>;

  delete(storageKey: string): Promise<void>;
}
```

Initial providers:

1. `local`: development and simple deployments; stores files under the gateway
   data directory.
2. `s3`: production object storage.
3. `supabase`: optional production storage when deployments already use
   Supabase.

Runtime code and tools should depend on `AttachmentStorage`, not on provider
details.

## Upload Flow

Use a dedicated upload endpoint instead of sending files through
`session.message`:

```http
POST /api/agents/:agentId/sessions/:sessionId/attachments
Content-Type: multipart/form-data
```

Flow:

1. Authenticate and verify session access.
2. Validate file count, size, name, and MIME type.
3. Stream bytes into the configured storage provider.
4. Compute `sha256` while streaming.
5. Insert the attachment metadata row, recording the authenticated
   `uploader_user_id` alongside `agent_id` and `session_id` so attachments can
   later be queried by user across sessions.
6. Decide whether to materialize into the sandbox.
7. Return attachment metadata to the client.
8. Client sends the normal session message with attachment IDs.

Message sending stays lightweight:

```json
{
  "text": "Summarize this PDF.",
  "attachments": [
    {
      "id": "att_...",
      "type": "file",
      "name": "report.pdf",
      "mimeType": "application/pdf",
      "size": 123456,
      "sandboxPath": "/home/user/.openhermit/attachments/web-123/att_.../report.pdf",
      "materializationState": "copied"
    }
  ]
}
```

## Sandbox Materialization

Eligible files should be copied into the active execution backend under an
agent-owned attachment directory:

```text
<agentHome>/.openhermit/attachments/<sessionId>/<attachmentId>/<safeName>
```

The materializer should:

- read from `AttachmentStorage`
- write through the active `ExecBackend.files.write`
- update `sandbox_path`, `sandbox_id`, and `materialization_state`
- never write outside `<agentHome>/.openhermit/attachments/`
- use sanitized filenames and attachment IDs to avoid path collisions

Suggested default policy:

- Copy small files automatically.
- Skip automatic sandbox copy for files above a configurable threshold, for
  example `OPENHERMIT_ATTACHMENT_SANDBOX_COPY_MAX_BYTES`.
- Always keep the durable storage object, even when sandbox copy fails.

Sandbox paths are cache entries, not the source of truth. If a sandbox is
recreated, the runner should either re-materialize referenced attachments or mark
them as not currently materialized and let tools fetch them on demand.

## Description Generation (deferred)

> **Status:** not implemented. The shipped schema has no `description` /
> `description_state` columns and no extractor runs at upload time. The section
> below is retained as the design sketch for a future phase.

At upload time the gateway would run a bounded, best-effort content extractor
and persist the result on the attachment row as `description`. The goal is to
give the agent a short, scannable preview of each file in `attachment_list` and
in the user message context — enough to decide whether to fetch or read it in
full — without shipping bytes to the model.

This is intentionally not document parsing. Extraction is bounded and produces
a single short text blob; deeper inspection stays in explicit tools.

Per-MIME strategies for the first implementation:

- `text/*`, `application/json`, common source-code types: first N kilobytes,
  whitespace-trimmed and truncated with an ellipsis.
- `application/pdf`: text from the first page via a lightweight extractor,
  truncated. No OCR.
- `image/*`: dimensions, format, and any embedded title/description from EXIF
  or XMP metadata. No vision-model call in Phase 1.
- `audio/*`, `video/*`: container metadata (duration, codec, dimensions, sample
  rate). No transcription.
- archives (`application/zip`, `application/x-tar`, etc.): top-level entry
  names, truncated.
- everything else: skipped.

Lifecycle via `description_state`:

- `pending` — extractor queued or running.
- `ready` — `description` is populated.
- `skipped` — MIME type has no configured extractor, or file exceeds the
  per-extractor size cap.
- `failed` — extractor errored; the error is captured in logs and may share the
  `materialization_error` column or use a dedicated field.

Extraction must be bounded: a per-file timeout, a per-file byte cap, and a
worker pool so a single upload cannot stall the upload endpoint. The upload
response should not block on description readiness — clients may receive
`pending` and poll, or send the session message immediately. `attachment_list`
and `createUserMessage` should both surface whatever state is current at read
time, so an agent never has to assume `description` is present.

Extractor selection is configurable. The first implementation can run entirely
in-process; deployments that want richer extraction (e.g., OCR, transcription,
embedding-based summarization) can plug in a worker queue later without
changing the message-context shape or the attachment row schema.

## Large Files

Large files should not be copied into the sandbox by default. They remain
available through attachment tools:

| Tool | Purpose |
|------|---------|
| `attachment_list` | List attachments. Defaults to the current session; pass `scope: 'user'` to list every attachment the same authenticated user uploaded under this agent. Cross-user listing is never permitted, even within the same agent. |
| `attachment_fetch` | Read or materialize an attachment on demand. Accepts `attachment_id`, an optional `mode` (`auto` \| `text` \| `image` \| `metadata`), and `max_bytes` (default 512 KiB). Files larger than `max_bytes` return metadata + `sandbox_path` so the agent can read on disk. |

`attachment_fetch` returns inline text for `text/*`, an image block for
`image/*` (when supported), or metadata otherwise. For in-sandbox reads, the
agent typically just uses `sandbox_path` with existing file tools.

A signed-URL tool (`attachment_url`) is deferred to Phase 2 (multimodal
routing), where external services or model APIs need to consume the object
directly without round-tripping through the sandbox.

## Model Context

`createUserMessage` renders attachments as a concise, structured list in the
user message context, e.g.:

```text
Attached files:
- report.pdf (application/pdf, 123 KB)
  attachment_id: att_...
  sandbox_path: /home/user/.openhermit/attachments/web-123/att_.../report.pdf

- long-video.mp4 (video/mp4, 2.1 GB)
  attachment_id: att_...
  sandbox_path: not materialized
  use attachment_fetch when needed
```

The prompt explicitly tells the model not to infer file contents from file
names. It must inspect files with tools.

Multimodal-capable models additionally receive image attachments inlined as
content blocks (gated on `supportsImageInput`). Text-only models see only the
list and rely on tools. Audio/video routing is still pending.

## Tool Strategy

Phase 1 tools:

- `attachment_list` — IDs, metadata, sandbox path, and materialization state.
  Scope defaults to the current session; pass `scope: 'user'` to list every
  attachment the same authenticated user uploaded under this agent. Results
  are always filtered by `agent_id`, so a user's uploads under one agent do
  not leak into another.
- `attachment_fetch` — read an attachment's bytes (text/image) or pull it into
  the sandbox on demand.
- existing `file_read`, `file_list`, `file_stat`, `exec` — once a file has a
  `sandbox_path`, it is just a file

Dedicated parsing tools (PDF page extraction, spreadsheet preview, archive
listing, OCR, transcription, media probe, etc.) are out of scope for this
proposal. They can be considered separately once the availability loop is
reliable, and only with explicit, auditable invocation — upload itself must
never silently extract or summarize content.

## Security

Implementation must enforce:

- session access before upload, list, URL signing, or fetch
- per-agent scoping on every attachment lookup
- user-scoped lookups (`attachment_list` with `scope: 'user'`) must additionally
  match the calling user against `uploader_user_id`; cross-user listing is
  never permitted, even within the same agent
- upload size limits
- safe filename normalization
- MIME allow/deny policy
- no direct exposure of provider storage keys to the model
- short-lived signed URLs
- sandbox writes only under the attachment materialization root
- auditability through session events or structured logs

`exec` users with sufficient privileges can still read sandbox-materialized
files. That is intentional and matches the existing sandbox trust model.

## Phased Implementation

### Phase 1: File Availability — shipped

1. [done] Attachment metadata table and store interface.
2. [done] `local`, `s3`, and `supabase` `AttachmentStorage` providers.
3. [done] Multipart upload endpoint.
4. [deferred] Server-side description extractor — see "Description Generation".
5. [done] Automatic sandbox materialization for files under the size threshold.
6. [done] `SessionAttachment` validation accepts attachment IDs, metadata, and
   `url`-passthrough.
7. [done] Attachment list rendered into `createUserMessage` context.
8. [done] `attachment_list` (with `scope`) and `attachment_fetch` (with `mode` /
   `max_bytes`).
9. [done] Web composer uploads files before sending the message.
10. [done] Attachment chips in web history.

An agent can receive a PDF or text file, see it listed in context, and read it
via `sandbox_path` or `attachment_fetch`.

### Phase 2: Multimodal Model Routing — partial

- [done] Image inlining for multimodal-capable models (gated on
  `supportsImageInput`).
- [pending] `attachment_url` (short-lived signed URLs) for external/model APIs
  that consume by URL.
- [pending] Audio / video routing into native model content blocks.

Text-only models continue to see the structured attachment list and rely on
tools.

### Future: Description Generation

The bounded per-MIME extractor sketched under "Description Generation" is not
yet built. It would add `description` / `description_state` columns and a
worker pool; until then `attachment_list` returns metadata only and the agent
uses `attachment_fetch` to inspect content.

## Open Decisions

- Default automatic materialization threshold.
- Whether storage should support deduplication by `sha256`.
- Retention policy for attachments after session deletion: the user's earlier
  uploads should remain visible via `scope: 'user'` lookups, so retention is
  per-uploader rather than per-session.
- Whether channel adapters may upload remote media directly, or whether they
  should pass URLs for gateway-side ingestion.
