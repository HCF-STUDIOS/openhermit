import type { Command } from 'commander';

import { readPath, writePath, parseScalar, formatScalar } from '@openhermit/shared';

import { createGateway, handleError } from './shared.js';

// ── Helpers ────────────────────────────────────────────────────────────

/** Walk up the commander parent chain to find --agent. */
const resolveAgentId = (cmd: Command): string => {
  let current: Command | null = cmd;
  while (current) {
    const opts = current.opts() as Record<string, unknown>;
    if (typeof opts.agent === 'string') return opts.agent;
    current = current.parent;
  }
  return process.env.OPENHERMIT_AGENT_ID ?? 'main';
};

const getPath = readPath;
const formatValue = formatScalar;
const parseValue = parseScalar;

// ── Command ────────────────────────────────────────────────────────────

export const registerConfigCommand = (program: Command): void => {
  const cfg = program
    .command('config')
    .description('View and modify agent configuration')
    .requiredOption('--agent <id>', 'Agent to configure', process.env.OPENHERMIT_AGENT_ID ?? 'main');

  // --- show ---
  cfg
    .command('show')
    .description('Show the full agent config')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const config = await gateway.getAgentConfig(agentId);
        console.log(JSON.stringify(config, null, 2));
      } catch (error) {
        handleError(error);
      }
    });

  // --- get ---
  cfg
    .command('get <key>')
    .description('Get a config value by dot-path (e.g. model.provider)')
    .action(async function (this: Command, key: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const config = await gateway.getAgentConfig(agentId);
        const value = getPath(config, key);
        if (value === undefined) {
          console.error(`Key not found: ${key}`);
          process.exit(1);
        }
        console.log(formatValue(value));
      } catch (error) {
        handleError(error);
      }
    });

  // --- set ---
  cfg
    .command('set <key> <value>')
    .description('Set a config value by dot-path (e.g. model.provider anthropic)')
    .action(async function (this: Command, key: string, rawValue: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const config = await gateway.getAgentConfig(agentId);
        const value = parseValue(rawValue);
        const next = writePath(config, key, value);
        await gateway.putAgentConfig(agentId, next);
        console.log(`${key} = ${formatValue(value)}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- secrets ---
  const secrets = cfg
    .command('secrets')
    .description('Manage agent secrets (inherits --agent from `config`; defaults to $OPENHERMIT_AGENT_ID or "main")');

  secrets
    .command('list')
    .description('List secret names (values are masked)')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const map = await gateway.getAgentSecrets(agentId);
        const keys = Object.keys(map).sort();
        if (keys.length === 0) {
          console.log('No secrets configured.');
          return;
        }
        // Values returned by the gateway are already masked.
        for (const key of keys) {
          const entry = map[key]!;
          const flag = entry.passThrough ? ' [pass-through]' : '';
          console.log(`  ${key} = ${entry.masked}${flag}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  secrets
    .command('set <key> <value>')
    .description('Set a secret (e.g. ANTHROPIC_API_KEY sk-...)')
    .option('--pass-through', 'Inject this secret as an env var into the agent\'s sandboxes at startup')
    .option('--no-pass-through', 'Do not inject this secret into sandboxes (default)')
    .action(async function (this: Command, key: string, value: string) {
      const agentId = resolveAgentId(this);
      // Commander gives us `passThrough: true` for --pass-through,
      // `passThrough: false` for --no-pass-through, and `undefined` if
      // neither was passed (preserve existing flag on the server).
      const opts = this.opts() as { passThrough?: boolean };
      try {
        const gateway = createGateway();
        await gateway.setAgentSecret(
          agentId,
          key,
          value,
          opts.passThrough !== undefined ? { passThrough: opts.passThrough } : undefined,
        );
        const flag = opts.passThrough === true
          ? ' (pass-through enabled)'
          : opts.passThrough === false
            ? ' (pass-through disabled)'
            : '';
        console.log(`Secret set: ${key}${flag}`);
      } catch (error) {
        handleError(error);
      }
    });

  secrets
    .command('remove <key>')
    .description('Remove a secret')
    .action(async function (this: Command, key: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        await gateway.deleteAgentSecret(agentId, key);
        console.log(`Secret removed: ${key}`);
      } catch (error) {
        handleError(error);
      }
    });

  // ── policy ────────────────────────────────────────────────────────

  const policy = cfg
    .command('policy')
    .description('Manage tool access policies (inherits --agent from `config`)');

  policy
    .command('list')
    .description('List all policies')
    .option('--resource-type <type>', 'Filter by resource type (e.g. "tool")')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const policies = await gateway.listPolicies(agentId, this.opts().resourceType) as Array<Record<string, unknown>>;
        if (policies.length === 0) {
          console.log('No policies configured.');
          return;
        }
        for (const p of policies) {
          const scope = p.scope && typeof p.scope === 'object' && Object.keys(p.scope as Record<string, unknown>).length > 0
            ? ` scope=${JSON.stringify(p.scope)}`
            : '';
          const effect = p.effect && p.effect !== 'allow' ? ` [${p.effect}]` : '';
          console.log(`  ${p.resourceType}/${p.resourceKey}${effect}${scope}`);
          console.log(`    grants: ${JSON.stringify(p.grants)}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  policy
    .command('set <resource-key> <grants-json>')
    .description('Set a tool policy (e.g. hermit config policy set exec \'[{"type":"any"}]\')')
    .option('--resource-type <type>', 'Resource type', 'tool')
    .option('--effect <effect>', 'Policy effect: allow, deny, or require_approval', 'allow')
    .option('--scope <json>', 'Scope JSON object')
    .action(async function (this: Command, resourceKey: string, grantsJson: string) {
      const agentId = resolveAgentId(this);
      const opts = this.opts() as { resourceType: string; effect: string; scope?: string };
      try {
        let grants: unknown[];
        try {
          grants = JSON.parse(grantsJson);
          if (!Array.isArray(grants)) throw new Error();
        } catch {
          console.error('grants must be a valid JSON array, e.g. \'[{"type":"any"}]\'');
          process.exit(1);
        }
        let scope: Record<string, unknown> = {};
        if (opts.scope) {
          try {
            scope = JSON.parse(opts.scope);
          } catch {
            console.error('scope must be a valid JSON object');
            process.exit(1);
          }
        }
        const gateway = createGateway();
        await gateway.upsertPolicy(agentId, {
          resourceType: opts.resourceType,
          resourceKey,
          effect: opts.effect,
          grants,
          scope,
        });
        console.log(`Policy set: ${opts.resourceType}/${resourceKey} [${opts.effect}] → ${grantsJson}`);
      } catch (error) {
        handleError(error);
      }
    });

  policy
    .command('delete <resource-key>')
    .description('Delete a tool policy')
    .option('--resource-type <type>', 'Resource type', 'tool')
    .option('--effect <effect>', 'Delete only this effect (omit to delete all)')
    .action(async function (this: Command, resourceKey: string) {
      const agentId = resolveAgentId(this);
      const opts = this.opts() as { resourceType: string; effect?: string };
      try {
        const gateway = createGateway();
        await gateway.deletePolicy(agentId, opts.resourceType, resourceKey, opts.effect);
        console.log(`Policy deleted: ${opts.resourceType}/${resourceKey}`);
      } catch (error) {
        handleError(error);
      }
    });

  // ── security ──────────────────────────────────────────────────────
  // Read / overwrite the agent's security policy: autonomy_level,
  // require_approval_for, access ('public' | 'protected' | 'private'),
  // access_token, channel_tokens.

  const security = cfg
    .command('security')
    .description('View and modify agent security policy (inherits --agent from `config`)');

  security
    .command('show')
    .description('Show the full security policy as JSON')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const policy = await gateway.getAgentSecurity(agentId);
        console.log(JSON.stringify(policy, null, 2));
      } catch (error) {
        handleError(error);
      }
    });

  security
    .command('get <key>')
    .description('Get a security policy value by dot-path (e.g. access)')
    .action(async function (this: Command, key: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const policy = await gateway.getAgentSecurity(agentId);
        const value = getPath(policy, key);
        if (value === undefined) {
          console.error(`Key not found: ${key}`);
          process.exit(1);
        }
        console.log(formatValue(value));
      } catch (error) {
        handleError(error);
      }
    });

  security
    .command('set <key> <value>')
    .description('Set a security policy value by dot-path (e.g. access private)')
    .action(async function (this: Command, key: string, rawValue: string) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const policy = await gateway.getAgentSecurity(agentId);
        const value = parseValue(rawValue);
        const next = writePath(policy, key, value);
        await gateway.putAgentSecurity(agentId, next);
        console.log(`${key} = ${formatValue(value)}`);
      } catch (error) {
        handleError(error);
      }
    });

  security
    .command('write')
    .description('Overwrite the entire security policy from stdin (JSON)')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          console.error('No JSON received on stdin.');
          process.exit(1);
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          console.error('Security policy must be a JSON object.');
          process.exit(1);
        }
        const gateway = createGateway();
        await gateway.putAgentSecurity(agentId, parsed as Record<string, unknown>);
        console.log('Security policy updated.');
      } catch (error) {
        handleError(error);
      }
    });

  // ── approvals ────────────────────────────────────────────────────

  const approvals = cfg
    .command('approvals')
    .description('Manage approval requests (inherits --agent from `config`)');

  approvals
    .command('list')
    .description('List approval requests')
    .option('--status <status>', 'Filter by status (pending, approved, rejected, expired)')
    .action(async function (this: Command) {
      const agentId = resolveAgentId(this);
      try {
        const gateway = createGateway();
        const requests = await gateway.listApprovalRequests(agentId, this.opts().status) as Array<Record<string, unknown>>;
        if (requests.length === 0) {
          console.log('No approval requests.');
          return;
        }
        for (const r of requests) {
          const status = r.status as string;
          const badge = status === 'pending' ? '⏳' : status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '⌛';
          console.log(`  ${badge} ${r.id}`);
          console.log(`    ${r.resourceType}/${r.resourceKey} [${status}]`);
          console.log(`    requester: ${r.requesterId} | session: ${r.sessionId}`);
          if (r.resolvedBy) console.log(`    resolved by: ${r.resolvedBy}${r.resolution ? ` (${r.resolution})` : ''}`);
          if (r.reason) console.log(`    reason: ${r.reason}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  approvals
    .command('review <id> <decision>')
    .description('Approve or reject a request (decision: approved | rejected)')
    .option('--resolution <res>', 'Resolution: once (default) or persistent')
    .option('--reason <reason>', 'Reason for the decision')
    .action(async function (this: Command, id: string, decision: string) {
      const agentId = resolveAgentId(this);
      if (decision !== 'approved' && decision !== 'rejected') {
        console.error('Decision must be "approved" or "rejected".');
        process.exit(1);
      }
      const opts = this.opts() as { resolution?: string; reason?: string };
      try {
        const gateway = createGateway();
        await gateway.reviewApprovalRequest(agentId, id, {
          decision: decision as 'approved' | 'rejected',
          ...(opts.resolution ? { resolution: opts.resolution as 'once' | 'persistent' } : {}),
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
        console.log(`Request ${id}: ${decision}`);
      } catch (error) {
        handleError(error);
      }
    });
};
