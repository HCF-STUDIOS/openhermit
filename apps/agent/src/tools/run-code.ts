import { Type, type Static } from '@mariozechner/pi-ai';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';

/**
 * Code mode (programmatic tool calling) — SCAFFOLD, off by default.
 *
 * See `docs/code-mode-design.md`. This lands only the transport+execution shell:
 * the model writes a short program, we materialize it into the agent's sandbox
 * and run it with the language runtime, and return its output. The two pieces
 * that make code mode valuable — a generated, typed SDK for calling tools from
 * inside the program, and the host-side tool bridge that re-enters the guarded
 * policy/approval path — are deliberately NOT built here; they are the tracked
 * follow-up. The tool description says so, so the model does not assume a tool
 * SDK is available yet.
 *
 * Registered only when `ToolContext.codeModeEnabled` is set (wired from
 * `OPENHERMIT_CODE_MODE` in the runner), so production behavior is unchanged
 * until the flag is flipped.
 */

const RUN_CODE_DIR = '.openhermit/run-code';

type RunCodeLanguage = 'typescript' | 'javascript' | 'python';

const RunCodeParams = Type.Object({
  source: Type.String({
    description:
      'Program source to execute in the sandbox. Prefer this over many ' +
      'separate tool calls when the task is inherently programmatic (batch, ' +
      'filter, join, multi-step transform). Print results to stdout.',
  }),
  language: Type.Optional(
    Type.Union(
      [Type.Literal('typescript'), Type.Literal('javascript'), Type.Literal('python')],
      {
        description: 'Program language. Defaults to typescript.',
      },
    ),
  ),
  alias: Type.Optional(
    Type.String({
      description: 'Sandbox alias. Omit to use the default sandbox.',
    }),
  ),
});

type RunCodeArgs = Static<typeof RunCodeParams>;

const EXTENSION: Record<RunCodeLanguage, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
};

/** Shell command that runs the materialized program file with its runtime. */
const runCommand = (language: RunCodeLanguage, programPath: string): string => {
  switch (language) {
    case 'typescript':
      // tsx runs TS directly; assumes it is available in the sandbox image.
      return `npx --yes tsx ${programPath}`;
    case 'javascript':
      return `node ${programPath}`;
    case 'python':
      return `python3 ${programPath}`;
  }
};

export const createRunCodeTool = (
  context: ToolContext,
): PolicyAwareTool<typeof RunCodeParams> => ({
  // Owner-only by default, same posture as `exec`: code mode is at least as
  // powerful as shell execution, so it inherits the same gate.
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'run_code',
  label: 'Run code',
  description:
    'Execute a short program in the agent sandbox and return its output. ' +
    'EXPERIMENTAL: there is no tool SDK inside the program yet — it runs with ' +
    'plain runtime access only (no calling other agent tools from code). Use ' +
    'this for programmatic batch/transform work; use the individual tools for ' +
    'single actions.',
  parameters: RunCodeParams,
  execute: async (toolCallId, args: RunCodeArgs) => {
    if (!context.execBackendManager) {
      return {
        content: asTextContent(
          'run_code is unavailable: no execution backend configured for this agent.',
        ),
        details: {},
      };
    }

    const language: RunCodeLanguage = args.language ?? 'typescript';
    const backend = context.execBackendManager.get(args.alias);
    await backend.ensure();
    context.onExec?.();

    const dir = `${backend.agentHome}/${RUN_CODE_DIR}`;
    // Sanitize the tool-call id for use in a filename (ids are model/provider
    // supplied; keep only filesystem-safe characters).
    const safeId = toolCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'program';
    const programPath = `${dir}/program-${safeId}.${EXTENSION[language]}`;

    // Ensure the target directory exists before writing the program.
    await backend.exec(`mkdir -p ${dir}`);
    await backend.files.write(programPath, Buffer.from(args.source, 'utf8'), 'overwrite');

    // Expose the calling session/agent to the program, matching `exec`, so any
    // in-sandbox CLIs it spawns can route async results back to this session.
    const sessionEnv: Record<string, string> = {
      ...(context.sessionId ? { OPENHERMIT_SESSION_ID: context.sessionId } : {}),
      ...(context.agentId ? { OPENHERMIT_AGENT_ID: context.agentId } : {}),
    };

    const result = await backend.exec(runCommand(language, programPath), {
      cwd: backend.agentHome,
      ...(Object.keys(sessionEnv).length > 0 ? { env: sessionEnv } : {}),
    });

    const details = {
      language,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.parsedOutput !== undefined ? { parsedOutput: result.parsedOutput } : {}),
    };

    return {
      content: asTextContent(formatJson(details)),
      details,
    };
  },
});

// ── Toolset ────────────────────────────────────────────────────────

const RUN_CODE_DESCRIPTION = `\
### Code mode (experimental)

Use \`run_code\` to execute a short program in the sandbox when a task is
inherently programmatic — batching, filtering, joining, or multi-step
transforms over data you would otherwise fetch with many separate tool calls.
Running the loop inside one program keeps intermediate data out of the
conversation.

**Experimental limits:** the program runs with plain runtime access only. There
is no SDK for calling other agent tools from inside the program yet — do that
work with the individual tools. Print what you need back to stdout.`;

export const createRunCodeToolset = (context: ToolContext): Toolset => ({
  id: 'run_code',
  description: RUN_CODE_DESCRIPTION,
  tools: [createRunCodeTool(context)],
});
