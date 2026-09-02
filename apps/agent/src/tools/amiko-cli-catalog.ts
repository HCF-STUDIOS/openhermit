import { execFile } from 'node:child_process';

/**
 * Amiko CLI tool catalog for Gemini Tool Retrieval (client-side tool_search).
 *
 * Each entry maps one readonly-leaning Amiko CLI subcommand to a function
 * declaration the model can discover via `amiko_tool_search` and then call.
 * Execution shells out to the `amiko` binary (configurable via AMIKO_BIN;
 * AMIKO_CWD selects the directory whose `.amiko.json` provides twin auth).
 * Tokens/secrets are never part of argv — auth is resolved by the CLI itself
 * from its config file / environment.
 */

export interface AmikoCatalogEntry {
  /** Tool name exposed to the model, e.g. `amiko_credits_balance`. */
  name: string;
  description: string;
  /** JSON-schema parameters object (Interactions function declaration shape). */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Build the amiko CLI argv (without the binary) from validated args. */
  argv: (args: Record<string, unknown>) => string[];
  /** True when the command only reads state. Mutating entries are excluded from the default smoke. */
  readonly: boolean;
  /** Extra keywords to boost search matching beyond name/description tokens. */
  keywords?: string[];
}

const str = (v: unknown): string => String(v ?? '');

const opt = (args: Record<string, unknown>, key: string, flag: string): string[] =>
  args[key] === undefined || args[key] === null || args[key] === '' ? [] : [flag, str(args[key])];

const limitParam = {
  limit: { type: 'number', description: 'Maximum number of rows to return.' },
};

export const AMIKO_CLI_CATALOG: AmikoCatalogEntry[] = [
  {
    name: 'amiko_version',
    description: 'Show the installed Amiko CLI version.',
    parameters: { type: 'object', properties: {} },
    argv: () => ['--version'],
    readonly: true,
    keywords: ['version', 'cli', 'release', 'build'],
  },
  {
    name: 'amiko_credits_balance',
    description: 'Show the twin\'s Amiko credit balance (10,000 credits = $1).',
    parameters: { type: 'object', properties: {} },
    argv: () => ['credits', 'balance'],
    readonly: true,
    keywords: ['credits', 'balance', 'money', 'funds', 'account'],
  },
  {
    name: 'amiko_accounts',
    description: 'Show resolved identity: platform, user id, twin id, and wallets.',
    parameters: { type: 'object', properties: {} },
    argv: () => ['accounts'],
    readonly: true,
    keywords: ['identity', 'whoami', 'account', 'twin', 'user'],
  },
  {
    name: 'amiko_info',
    description: 'Get twin info: name, description, voice ids, avatar.',
    parameters: { type: 'object', properties: {} },
    argv: () => ['info'],
    readonly: true,
    keywords: ['twin', 'profile', 'about'],
  },
  {
    name: 'amiko_config_show',
    description: 'Show resolved CLI configuration (from .amiko.json). Secrets are managed by the CLI.',
    parameters: { type: 'object', properties: {} },
    argv: () => ['config'],
    readonly: true,
    keywords: ['config', 'settings', 'setup'],
  },
  {
    name: 'amiko_wallets_list',
    description: 'List wallets for the authenticated twin (addresses and chains).',
    parameters: { type: 'object', properties: {} },
    argv: () => ['wallets', 'list'],
    readonly: true,
    keywords: ['wallet', 'solana', 'base', 'address', 'crypto'],
  },
  {
    name: 'amiko_wallets_balance',
    description: 'Sync and show token balances for a single twin wallet address.',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address (Solana or Base).' },
      },
      required: ['address'],
    },
    argv: (a) => ['wallets', 'balance', str(a.address)],
    readonly: true,
    keywords: ['wallet', 'balance', 'tokens', 'sol', 'usdc'],
  },
  {
    name: 'amiko_chat_list',
    description: 'List the owner\'s conversations (DMs and group chats).',
    parameters: { type: 'object', properties: { ...limitParam } },
    argv: (a) => ['chat', 'list', ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['chat', 'conversations', 'messages', 'dm', 'group'],
  },
  {
    name: 'amiko_chat_read',
    description: 'Read recent messages in a conversation (by conversation id, user id, @handle, or name).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Conversation id, user id, @handle, or name.' },
        ...limitParam,
      },
      required: ['target'],
    },
    argv: (a) => ['chat', 'read', str(a.target), ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['chat', 'read', 'messages', 'history'],
  },
  {
    name: 'amiko_chat_send',
    description: 'Send a chat message as the owner to a conversation or person.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Conversation id, user id, @handle, or name.' },
        message: { type: 'string', description: 'Message text to send.' },
      },
      required: ['target', 'message'],
    },
    argv: (a) => ['chat', 'send', str(a.target), str(a.message)],
    readonly: false,
    keywords: ['chat', 'send', 'message', 'reply'],
  },
  {
    name: 'amiko_drive_list',
    description: 'List twin drive files, optionally filtered by folder or search term.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder to list.' },
        ...limitParam,
      },
    },
    argv: (a) => ['drive', 'list', ...opt(a, 'folder', '--folder'), ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['drive', 'files', 'docs', 'documents', 'storage'],
  },
  {
    name: 'amiko_drive_search',
    description: 'Search drive files by name, description, or parsed content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        ...limitParam,
      },
      required: ['query'],
    },
    argv: (a) => ['drive', 'search', str(a.query), ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['drive', 'search', 'files', 'rag'],
  },
  {
    name: 'amiko_drive_get',
    description: 'Show one drive file\'s metadata, parsed content, and signed URL.',
    parameters: {
      type: 'object',
      properties: { doc_id: { type: 'string', description: 'Drive document id.' } },
      required: ['doc_id'],
    },
    argv: (a) => ['drive', 'get', str(a.doc_id)],
    readonly: true,
    keywords: ['drive', 'file', 'metadata', 'download'],
  },
  {
    name: 'amiko_friends_list',
    description: 'List the twin owner\'s friends.',
    parameters: { type: 'object', properties: { ...limitParam } },
    argv: (a) => ['friends', 'list', ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['friends', 'social', 'contacts'],
  },
  {
    name: 'amiko_friends_requests',
    description: 'List pending friend requests (incoming and outgoing).',
    parameters: { type: 'object', properties: {} },
    argv: () => ['friends', 'requests'],
    readonly: true,
    keywords: ['friends', 'requests', 'pending', 'invitations'],
  },
  {
    name: 'amiko_friends_matches',
    description: 'List friend matches suggested for the owner.',
    parameters: { type: 'object', properties: { ...limitParam } },
    argv: (a) => ['friends', 'matches', ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['friends', 'matches', 'matchmaking', 'suggestions'],
  },
  {
    name: 'amiko_users_search',
    description: 'Search Amiko users by name or handle.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or handle to search for.' },
        ...limitParam,
      },
      required: ['query'],
    },
    argv: (a) => ['users', 'search', str(a.query), ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['users', 'people', 'search', 'handle'],
  },
  {
    name: 'amiko_users_profile',
    description: 'View a user\'s public profile by handle.',
    parameters: {
      type: 'object',
      properties: { handle: { type: 'string', description: 'User handle, with or without @.' } },
      required: ['handle'],
    },
    argv: (a) => ['users', 'profile', str(a.handle)],
    readonly: true,
    keywords: ['users', 'profile', 'public'],
  },
  {
    name: 'amiko_notifications_list',
    description: 'List platform notifications (friend requests, system alerts, activity).',
    parameters: { type: 'object', properties: { ...limitParam } },
    argv: (a) => ['notifications', 'list', ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['notifications', 'alerts', 'activity', 'inbox'],
  },
  {
    name: 'amiko_memory_list',
    description: 'List the caller\'s cross-agent memories, newest first.',
    parameters: { type: 'object', properties: { ...limitParam } },
    argv: (a) => ['memory', 'list', ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['memory', 'memories', 'recall'],
  },
  {
    name: 'amiko_memory_search',
    description: 'Hybrid search across the caller\'s cross-agent memories.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        ...limitParam,
      },
      required: ['query'],
    },
    argv: (a) => ['memory', 'search', str(a.query), ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['memory', 'search', 'recall'],
  },
  {
    name: 'amiko_memory_status',
    description: 'Show counts of memories and uploaded memory files.',
    parameters: { type: 'object', properties: {} },
    argv: () => ['memory', 'status'],
    readonly: true,
    keywords: ['memory', 'status', 'counts'],
  },
  {
    name: 'amiko_feed',
    description: 'Get recent feed posts.',
    parameters: { type: 'object', properties: { ...limitParam } },
    argv: (a) => ['feed', ...opt(a, 'limit', '--limit')],
    readonly: true,
    keywords: ['feed', 'posts', 'timeline', 'social'],
  },
  {
    name: 'amiko_markets_discover',
    description: 'Show MPP marketplace service info, endpoints, and pricing.',
    parameters: { type: 'object', properties: {} },
    argv: () => ['markets', 'discover'],
    readonly: true,
    keywords: ['markets', 'marketplace', 'mpp', 'services', 'pricing'],
  },
  {
    name: 'amiko_markets_ping',
    description: 'Check whether the MPP marketplace service is online.',
    parameters: { type: 'object', properties: {} },
    argv: () => ['markets', 'ping'],
    readonly: true,
    keywords: ['markets', 'ping', 'health', 'online'],
  },
];

const byName = new Map(AMIKO_CLI_CATALOG.map((e) => [e.name, e]));

export const getCatalogEntry = (name: string): AmikoCatalogEntry | undefined => byName.get(name);

/** Interactions-API function declaration shape for a catalog entry. */
export interface FunctionDeclaration {
  type: 'function';
  name: string;
  description: string;
  parameters: AmikoCatalogEntry['parameters'];
}

export const toFunctionDeclaration = (entry: AmikoCatalogEntry): FunctionDeclaration => ({
  type: 'function',
  name: entry.name,
  description: entry.description,
  parameters: entry.parameters,
});

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/**
 * Rank catalog entries against a free-text query by token overlap over
 * name, description, and keywords. Deliberately simple and deterministic —
 * the model refines with follow-up searches when the first page misses.
 */
export const searchCatalog = (query: string, limit = 8): AmikoCatalogEntry[] => {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return AMIKO_CLI_CATALOG.slice(0, limit);
  const scored = AMIKO_CLI_CATALOG.map((entry) => {
    const haystackTokens = new Set([
      ...tokenize(entry.name),
      ...tokenize(entry.description),
      ...(entry.keywords ?? []).flatMap(tokenize),
    ]);
    let score = 0;
    for (const qt of queryTokens) {
      if (haystackTokens.has(qt)) score += 2;
      else if ([...haystackTokens].some((ht) => ht.startsWith(qt) || qt.startsWith(ht))) score += 1;
    }
    return { entry, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map((s) => s.entry);
};

export interface RunAmikoOptions {
  /** Path to the amiko binary. Default: env AMIKO_BIN, else `amiko` from PATH. */
  bin?: string;
  /** Working directory (where `.amiko.json` lives). Default: env AMIKO_CWD, else process cwd. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunAmikoResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute a catalog tool by shelling out to the Amiko CLI. argv is built by
 * the entry's own mapper — arguments are passed via execFile (no shell), so
 * user-controlled values cannot inject commands.
 */
export const runAmikoTool = (
  name: string,
  args: Record<string, unknown>,
  options: RunAmikoOptions = {},
): Promise<RunAmikoResult> => {
  const entry = byName.get(name);
  if (!entry) return Promise.reject(new Error(`Unknown Amiko catalog tool: ${name}`));
  const argv = entry.argv(args ?? {});
  const bin = options.bin ?? process.env.AMIKO_BIN ?? 'amiko';
  const cwd = options.cwd ?? process.env.AMIKO_CWD ?? process.cwd();
  const timeout = options.timeoutMs ?? 60_000;
  // `.js` entrypoints (a pinned checkout build) run through node explicitly so
  // AMIKO_BIN doesn't depend on the file's executable bit or shebang.
  const [file, prefix] = bin.endsWith('.js')
    ? [process.execPath, [bin]]
    : [bin, [] as string[]];
  return new Promise((resolve) => {
    execFile(
      file,
      [...prefix, ...argv],
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        env: process.env,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : 1
          : 0;
        resolve({
          command: ['amiko', ...argv].join(' '),
          exitCode,
          stdout: String(stdout ?? ''),
          stderr: error && !stderr ? String(error.message) : String(stderr ?? ''),
        });
      },
    );
  });
};
