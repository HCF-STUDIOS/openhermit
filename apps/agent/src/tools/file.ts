import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  checkApprovalOrRequest,
  formatJson,
} from './shared.js';
import type { ExecBackend, FileWriteMode } from '../core/index.js';
import {
  type FileMode,
  type PolicyRow,
  buildPrincipal,
  evaluateAccess,
  resolveFilePathMatches,
} from '../core/policy.js';

const SANDBOX_ARG = Type.Optional(
  Type.String({ description: 'Sandbox alias. Omit to use the default sandbox.' }),
);

const PATH_ARG = Type.String({
  description: 'Absolute path inside the sandbox (as the agent sees it).',
});

const FileReadParams = Type.Object({
  path: PATH_ARG,
  sandbox: SANDBOX_ARG,
  offset: Type.Optional(
    Type.Number({ description: 'Start reading from this line number (1-based). Omit to start from the beginning.' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of lines to return. Omit to read to the end (subject to 5 MiB cap).' }),
  ),
  encoding: Type.Optional(
    Type.Union([Type.Literal('utf8'), Type.Literal('base64')], {
      description: "How to return file bytes. 'utf8' (default) for text; 'base64' for binary.",
    }),
  ),
});

const FileWriteParams = Type.Object({
  path: PATH_ARG,
  content: Type.String({ description: 'File contents. Bytes if encoding=base64, text otherwise.' }),
  mode: Type.Optional(
    Type.Union(
      [Type.Literal('create'), Type.Literal('overwrite'), Type.Literal('append')],
      { description: "Write mode. 'overwrite' (default), 'create' (fail if exists), 'append'." },
    ),
  ),
  encoding: Type.Optional(
    Type.Union([Type.Literal('utf8'), Type.Literal('base64')], {
      description: "How to interpret content. 'utf8' (default) for text; 'base64' for binary.",
    }),
  ),
  sandbox: SANDBOX_ARG,
});

const FileListParams = Type.Object({
  path: PATH_ARG,
  sandbox: SANDBOX_ARG,
});

const FileStatParams = Type.Object({
  path: PATH_ARG,
  sandbox: SANDBOX_ARG,
});

const FileEditParams = Type.Object({
  path: PATH_ARG,
  find_text: Type.String({ description: 'The exact text to search for in the file.' }),
  replace_text: Type.String({ description: 'The text to replace it with.' }),
  replace_all: Type.Optional(
    Type.Boolean({ description: 'Replace all occurrences (default false — replace only the first match).' }),
  ),
  sandbox: SANDBOX_ARG,
});

const FileDeleteParams = Type.Object({
  path: PATH_ARG,
  sandbox: SANDBOX_ARG,
});

type FileReadArgs = Static<typeof FileReadParams>;
type FileWriteArgs = Static<typeof FileWriteParams>;
type FileEditArgs = Static<typeof FileEditParams>;
type FileListArgs = Static<typeof FileListParams>;
type FileStatArgs = Static<typeof FileStatParams>;
type FileDeleteArgs = Static<typeof FileDeleteParams>;

/** 5 MiB. Beyond this, results blow the model context budget. */
const MAX_READ_BYTES = 5 * 1024 * 1024;

const resolveBackend = (context: ToolContext, alias?: string): ExecBackend => {
  if (!context.execBackendManager) {
    throw new ValidationError('File tools are unavailable: no execution backend configured for this agent.');
  }
  return context.execBackendManager.get(alias);
};

let cachedFileRows: { agentId: string; rows: PolicyRow[] } | undefined;

const checkFilePath = async (
  context: ToolContext,
  sandboxAlias: string,
  mode: FileMode,
  path: string,
  args?: unknown,
): Promise<void> => {
  if (!context.policyStore || !context.agentId) return;

  if (!cachedFileRows || cachedFileRows.agentId !== context.agentId) {
    const rows = await context.policyStore.list(context.agentId, 'file');
    cachedFileRows = { agentId: context.agentId, rows };
  }

  const matches = resolveFilePathMatches(cachedFileRows.rows, sandboxAlias, mode, path);
  if (matches === undefined) return;

  const principal = context.agentId
    ? buildPrincipal(context.agentId, context.currentUserId, context.currentUserRole)
    : undefined;
  if (!principal) {
    throw new ValidationError(`Access denied: ${mode} ${path} (sandbox: ${sandboxAlias})`);
  }
  const decision = evaluateAccess(principal, matches, 'deny');
  if (decision === 'deny') {
    throw new ValidationError(`Access denied: ${mode} ${path} (sandbox: ${sandboxAlias})`);
  }
  if (decision === 'require_approval') {
    await checkApprovalOrRequest(context, 'file', `${sandboxAlias}:${mode}:${path}`, {
      sandbox: sandboxAlias,
      mode,
      path,
    }, args);
  }
};

export const createFileReadTool = (context: ToolContext): PolicyAwareTool<typeof FileReadParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'file_read',
  label: 'Read File',
  description:
    'Read a file from a sandbox by absolute path. Use offset (1-based line number) and limit (line count) to read a range of lines from large files. Returns text by default; use encoding=base64 for binary files. Hard cap of 5 MiB.',
  parameters: FileReadParams,
  execute: async (_id, args: FileReadArgs) => {
    const backend = resolveBackend(context, args.sandbox);
    await checkFilePath(context, backend.id, 'read', args.path, args);
    const { data } = await backend.files.read(args.path);
    if (data.byteLength > MAX_READ_BYTES && !args.offset && !args.limit) {
      throw new ValidationError(
        `File is ${data.byteLength.toLocaleString()} bytes; exceeds the ${MAX_READ_BYTES.toLocaleString()} byte cap. Use offset/limit to read a range, or exec for very large files.`,
      );
    }
    const encoding = args.encoding ?? 'utf8';

    if (encoding === 'base64') {
      const content = data.toString('base64');
      return {
        content: asTextContent(content),
        details: { path: args.path, sandbox: backend.id, size: data.byteLength, encoding },
      };
    }

    const fullText = data.toString('utf8');
    const allLines = fullText.split('\n');
    const totalLines = allLines.length;

    const offsetLine = Math.max(1, args.offset ?? 1);
    const startIdx = offsetLine - 1;
    const endIdx = args.limit != null ? Math.min(startIdx + args.limit, totalLines) : totalLines;
    const selectedLines = allLines.slice(startIdx, endIdx);

    // Number each line so the agent can reference positions.
    const numbered = selectedLines
      .map((line, i) => `${startIdx + i + 1}\t${line}`)
      .join('\n');

    return {
      content: asTextContent(numbered),
      details: {
        path: args.path,
        sandbox: backend.id,
        totalLines,
        startLine: startIdx + 1,
        endLine: endIdx,
        encoding,
      },
    };
  },
});

export const createFileWriteTool = (context: ToolContext): PolicyAwareTool<typeof FileWriteParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'file_write',
  label: 'Write File',
  description:
    "Write a file in a sandbox. Default mode is 'overwrite' (atomic write-and-rename). Use 'create' to fail if the file already exists, or 'append' to add to the end. Parent directories are created as needed.",
  parameters: FileWriteParams,
  execute: async (_id, args: FileWriteArgs) => {
    const backend = resolveBackend(context, args.sandbox);
    await checkFilePath(context, backend.id, 'write', args.path, args);
    const mode: FileWriteMode = args.mode ?? 'overwrite';
    const encoding = args.encoding ?? 'utf8';
    const data =
      encoding === 'base64' ? Buffer.from(args.content, 'base64') : Buffer.from(args.content, 'utf8');
    await backend.files.write(args.path, data, mode);
    return {
      content: asTextContent(`Wrote ${data.byteLength} bytes to ${args.path} (mode=${mode}).\n`),
      details: { path: args.path, sandbox: backend.id, mode, bytes: data.byteLength },
    };
  },
});

export const createFileListTool = (context: ToolContext): PolicyAwareTool<typeof FileListParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'file_list',
  label: 'List Directory',
  description: 'List entries (files + subdirectories) in a sandbox directory.',
  parameters: FileListParams,
  execute: async (_id, args: FileListArgs) => {
    const backend = resolveBackend(context, args.sandbox);
    await checkFilePath(context, backend.id, 'read', args.path, args);
    const entries = await backend.files.list(args.path);
    return {
      content: asTextContent(formatJson(entries)),
      details: { path: args.path, sandbox: backend.id, entries },
    };
  },
});

export const createFileStatTool = (context: ToolContext): PolicyAwareTool<typeof FileStatParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }, { type: 'role', value: 'user' }] },
  name: 'file_stat',
  label: 'Stat Path',
  description: 'Inspect a path in a sandbox: type (file/directory), size, last-modified time. Returns null if missing.',
  parameters: FileStatParams,
  execute: async (_id, args: FileStatArgs) => {
    const backend = resolveBackend(context, args.sandbox);
    await checkFilePath(context, backend.id, 'read', args.path, args);
    const stat = await backend.files.stat(args.path);
    return {
      content: asTextContent(stat ? formatJson(stat) : 'null\n'),
      details: { path: args.path, sandbox: backend.id, stat },
    };
  },
});

export const createFileEditTool = (context: ToolContext): PolicyAwareTool<typeof FileEditParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'file_edit',
  label: 'Edit File',
  description:
    'Find and replace text in a file. By default replaces only the first occurrence; set replace_all=true to replace every match. The find_text must match exactly (not a regex). Fails if find_text is not found.',
  parameters: FileEditParams,
  execute: async (_id, args: FileEditArgs) => {
    const backend = resolveBackend(context, args.sandbox);
    await checkFilePath(context, backend.id, 'write', args.path, args);
    const { data } = await backend.files.read(args.path);
    const original = data.toString('utf8');

    if (!original.includes(args.find_text)) {
      throw new ValidationError(
        `find_text not found in ${args.path}. Make sure the text matches exactly (including whitespace and newlines).`,
      );
    }

    let updated: string;
    let count: number;
    if (args.replace_all) {
      count = original.split(args.find_text).length - 1;
      updated = original.split(args.find_text).join(args.replace_text);
    } else {
      count = 1;
      const idx = original.indexOf(args.find_text);
      updated = original.slice(0, idx) + args.replace_text + original.slice(idx + args.find_text.length);
    }

    await backend.files.write(args.path, Buffer.from(updated, 'utf8'), 'overwrite');

    return {
      content: asTextContent(
        `Replaced ${count} occurrence${count > 1 ? 's' : ''} in ${args.path}.\n`,
      ),
      details: { path: args.path, sandbox: backend.id, replacements: count },
    };
  },
});

export const createFileDeleteTool = (context: ToolContext): PolicyAwareTool<typeof FileDeleteParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'file_delete',
  label: 'Delete File',
  description: 'Delete a single file in a sandbox. Refuses to delete directories (no recursion).',
  parameters: FileDeleteParams,
  execute: async (_id, args: FileDeleteArgs) => {
    const backend = resolveBackend(context, args.sandbox);
    await checkFilePath(context, backend.id, 'write', args.path, args);
    await backend.files.delete(args.path);
    return {
      content: asTextContent(`Deleted ${args.path}.\n`),
      details: { path: args.path, sandbox: backend.id },
    };
  },
});

const FILE_DESCRIPTION = `\
### File Tools

First-class file operations on a sandbox: \`file_read\`, \`file_write\`,
\`file_edit\`, \`file_list\`, \`file_stat\`, \`file_delete\`. Paths are
absolute, as the agent sees them inside the sandbox.

- \`file_read\`: read a file. Use \`offset\` (1-based line) and \`limit\` (line count) for large files.
- \`file_write\`: create / overwrite / append a file.
- \`file_edit\`: find-and-replace text in a file. Precise edits without rewriting the whole file.
- \`file_list\`, \`file_stat\`, \`file_delete\`: directory listing, stat, single-file delete.

Prefer these over \`exec cat\` / \`exec tee\` / \`exec sed\` for routine file work.
Use \`exec\` for shell-y things (search, build, scripts, processes).

For multi-sandbox agents, pass \`sandbox\` to choose; omit for the default.`;

export const createFileToolset = (context: ToolContext): Toolset => ({
  id: 'file',
  description: FILE_DESCRIPTION,
  tools: [
    createFileReadTool(context),
    createFileWriteTool(context),
    createFileEditTool(context),
    createFileListTool(context),
    createFileStatTool(context),
    createFileDeleteTool(context),
  ],
});
