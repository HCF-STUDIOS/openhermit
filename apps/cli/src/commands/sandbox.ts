import type { Command } from 'commander';
import { isSandboxType, SANDBOX_TYPES } from '@openhermit/protocol';

import { createGateway, handleError, printTable } from './shared.js';

export const registerSandboxCommand = (program: Command): void => {
  const sandbox = program
    .command('sandbox')
    .description('Manage agent sandboxes (execution environments)');

  sandbox
    .command('list')
    .description('List sandboxes for an agent')
    .requiredOption('--agent <id>', 'Agent ID')
    .action(async (opts: { agent: string }) => {
      try {
        const gateway = createGateway();
        const rows = await gateway.listSandboxes(opts.agent);
        if (rows.length === 0) {
          console.log('No sandboxes.');
          return;
        }
        printTable(
          rows.map((r) => ({
            alias: r.alias,
            type: r.type,
            status: r.status,
            id: r.id,
          })),
          [
            { key: 'alias', label: 'Alias' },
            { key: 'type', label: 'Type', width: 10 },
            { key: 'status', label: 'Status', width: 10 },
            { key: 'id', label: 'ID' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  sandbox
    .command('add')
    .description('Create a sandbox for an agent')
    .requiredOption('--agent <id>', 'Agent ID')
    .requiredOption('--type <type>', `Sandbox type: ${SANDBOX_TYPES.join(' | ')}`)
    .option('--alias <alias>', 'Sandbox alias (default: "default")')
    .option('--config <json>', 'JSON config blob (e.g. \'{"image":"ubuntu:24.04"}\')')
    .action(async (opts: { agent: string; type: string; alias?: string; config?: string }) => {
      try {
        const t = opts.type;
        if (!isSandboxType(t)) {
          console.error(`Invalid sandbox type: ${t}`);
          process.exit(1);
        }
        let config: Record<string, unknown> | undefined;
        if (opts.config) {
          try {
            config = JSON.parse(opts.config) as Record<string, unknown>;
          } catch (err) {
            console.error(`Invalid --config JSON: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        }
        const gateway = createGateway();
        await gateway.createSandbox(opts.agent, {
          type: t,
          ...(opts.alias ? { alias: opts.alias } : {}),
          ...(config ? { config } : {}),
        });
        console.log(`Created sandbox "${opts.alias ?? 'default'}" (${t}) for agent ${opts.agent}.`);
      } catch (error) {
        handleError(error);
      }
    });

  sandbox
    .command('remove')
    .description('Delete a sandbox by alias')
    .requiredOption('--agent <id>', 'Agent ID')
    .argument('<alias>', 'Sandbox alias')
    .action(async (alias: string, opts: { agent: string }) => {
      try {
        const gateway = createGateway();
        await gateway.deleteSandbox(opts.agent, alias);
        console.log(`Deleted sandbox "${alias}" from agent ${opts.agent}.`);
      } catch (error) {
        handleError(error);
      }
    });
};
