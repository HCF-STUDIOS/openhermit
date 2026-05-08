import { Type, type Static } from '@mariozechner/pi-ai';

import {
  type PolicyAwareTool,
  type Toolset,
  type ToolContext,
  asTextContent,
  checkApprovalOrRequest,
  formatJson,
} from './shared.js';
import {
  type PolicyRow,
  buildPrincipal,
  evaluateAccess,
  resolveExecMatches,
} from '../core/policy.js';
import { ValidationError } from '@openhermit/shared';

const SandboxExecParams = Type.Object({
  command: Type.String({
    description: 'Shell command to execute.',
  }),
  alias: Type.Optional(
    Type.String({
      description: 'Sandbox alias. Omit to use the default sandbox.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory. Defaults to the agent home directory.',
    }),
  ),
});

type SandboxExecArgs = Static<typeof SandboxExecParams>;

export const createSandboxExecTool = (
  context: ToolContext,
): PolicyAwareTool<typeof SandboxExecParams> => ({
  policy: { defaultGrants: [{ type: 'role', value: 'owner' }] },
  name: 'exec',
  label: 'Exec',
  description: buildExecDescription(context),
  parameters: SandboxExecParams,
  execute: async (_toolCallId, args: SandboxExecArgs) => {
    if (!context.execBackendManager) {
      return {
        content: asTextContent(
          'exec is unavailable: no execution backend configured for this agent.',
        ),
        details: {},
      };
    }

    const backend = context.execBackendManager.get(args.alias);

    if (context.policyStore && context.agentId) {
      const execRows = await context.policyStore.list(context.agentId, 'exec');
      const cwd = args.cwd ?? backend.agentHome;
      const matches = resolveExecMatches(execRows, backend.id, args.command, cwd);
      if (matches !== undefined) {
        const principal = buildPrincipal(context.agentId, context.currentUserId, context.currentUserRole);
        const decision = evaluateAccess(principal, matches, 'deny');
        if (decision === 'deny') {
          throw new ValidationError(`Access denied: exec command not allowed (sandbox: ${backend.id})`);
        }
        if (decision === 'require_approval') {
          await checkApprovalOrRequest(context, 'exec', `${backend.id}:${args.command}`, {
            sandbox: backend.id,
            command: args.command,
            ...(args.cwd ? { cwd: args.cwd } : {}),
          }, args);
        }
      }
    }

    await backend.ensure();
    context.onExec?.();
    const result = await backend.exec(args.command, args.cwd ? { cwd: args.cwd } : undefined);

    const details = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.parsedOutput !== undefined
        ? { parsedOutput: result.parsedOutput }
        : {}),
    };

    return {
      content: asTextContent(formatJson(details)),
      details,
    };
  },
});

function buildExecDescription(context: ToolContext): string {
  if (!context.execBackendManager) {
    return `Execute a shell command. Use this for build tools, language runtimes, tests, search (grep/find), and any other shell task. For reading, writing, or editing files, use the file tools (file_read, file_write, file_edit) instead.`;
  }
  const backends = context.execBackendManager.list();
  if (backends.length === 1) {
    const b = backends[0]!;
    return `Execute a shell command on ${b.label}. The workspace is at \`${b.agentHome}\`. Use this for build tools, language runtimes, tests, search (grep/find), and any other shell task. For reading, writing, or editing files, use the file tools (file_read, file_write, file_edit) instead.`;
  }
  const backendList = backends
    .map((b) => `- \`${b.id}\`: ${b.label} (workspace at \`${b.agentHome}\`)`)
    .join('\n');
  return `Execute a shell command. Use the \`alias\` parameter to choose a sandbox.\n\nAvailable sandboxes:\n${backendList}\n\nUse this for build tools, language runtimes, tests, search (grep/find), and any other shell task. For reading, writing, or editing files, use the file tools (file_read, file_write, file_edit) instead.`;
}

// ── Toolset ────────────────────────────────────────────────────────

const EXEC_DESCRIPTION = `\
### Execution

Use \`exec\` to run shell commands: build, test, install packages, run scripts, search (grep/find), git, and any other shell task.

**For file operations, use the file tools instead of exec:**
- \`file_read\` instead of \`cat\` / \`head\` / \`tail\` (supports line ranges with offset/limit)
- \`file_write\` instead of \`tee\` / \`echo >\` / redirection
- \`file_edit\` instead of \`sed\` for find-and-replace
- \`file_list\` instead of \`ls\`
- \`file_stat\` instead of \`stat\`
- \`file_delete\` instead of \`rm\`

The execution environment is persistent. Installed packages and state survive between calls.

**Important**: stdin is closed — interactive commands that prompt for user input will fail. Use non-interactive alternatives instead (e.g. \`--yes\`, \`--non-interactive\`, \`--with-token\`, environment variables). For authentication, use tokens from agent secrets rather than interactive login flows.

**Output is not streamed**: \`exec\` returns stdout/stderr only after the process exits. You will not see partial output during the run, so prefer many short calls over one long-running call.

**Long-running / daemon / tunnel commands** (ssh tunnels, dev servers, \`tail -f\`, watchers, anything that does not exit on its own): do NOT run them in the foreground — even with \`timeout N\`, you will get zero feedback for N seconds and may hit the wall-clock timeout. Instead:
1. Launch in the background, redirecting output: \`nohup <cmd> > /tmp/x.log 2>&1 &\` — this returns immediately with the PID.
2. In a second \`exec\` call, poll the log: \`sleep 2 && tail -n 50 /tmp/x.log\` (or grep it for the string you need).
3. When done, kill it explicitly: \`kill <pid>\` (capture the PID from \`$!\` after launch if needed).

**Avoid the \`timeout N <cmd> | grep …\` pattern** for capturing output from a process that would otherwise run forever. Two problems: (a) you get no feedback for N seconds; (b) \`grep\` block-buffers when its stdout is a pipe, so even matched lines may not flush before \`grep\` exits. Prefer redirect-then-grep: \`<cmd> > /tmp/x.log 2>&1; grep -E '…' /tmp/x.log\`, or add \`grep --line-buffered\` if you really must pipe.`;

export const createExecToolset = (context: ToolContext): Toolset => ({
  id: 'exec',
  description: EXEC_DESCRIPTION,
  tools: [createSandboxExecTool(context)],
});
