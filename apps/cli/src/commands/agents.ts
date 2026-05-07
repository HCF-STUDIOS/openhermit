import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

export const registerAgentsCommand = (program: Command): void => {
  const agents = program
    .command('agents')
    .description('Manage agents');

  // --- list ---
  agents
    .command('list')
    .description('List all registered agents')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = await gateway.listAgents();

        if (list.length === 0) {
          console.log('No agents registered.');
          return;
        }

        printTable(
          list.map((a) => ({
            id: a.agentId,
            name: a.name ?? '',
            status: a.status,
            workspace: a.workspaceDir ?? '',
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status', width: 10 },
            { key: 'workspace', label: 'Workspace' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  // --- create ---
  agents
    .command('create <agentId>')
    .description('Create a new agent')
    .option('--name <name>', 'Display name for the agent')
    .option('--workspace-dir <path>', 'Custom workspace directory')
    .option('--owner <userId>', 'Owner user ID')
    .option('--sandbox <preset>', 'Sandbox preset to provision (defaults to gateway autoProvisionSandbox)')
    .option('--no-sandbox', 'Skip sandbox provisioning entirely')
    .action(async (agentId: string, opts: {
      name?: string;
      workspaceDir?: string;
      owner?: string;
      sandbox?: string | false;
    }) => {
      try {
        const gateway = createGateway();
        // Commander turns `--no-sandbox` into `sandbox: false`; map both
        // forms onto the API's `sandbox: string | null` field.
        const sandboxField: { sandbox: string | null } | object =
          opts.sandbox === false
            ? { sandbox: null }
            : typeof opts.sandbox === 'string'
              ? { sandbox: opts.sandbox }
              : {};
        const result = await gateway.createAgent({
          agentId,
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
          ...(opts.owner ? { ownerUserId: opts.owner } : {}),
          ...sandboxField,
        });
        console.log(`Agent created: ${result.agentId} (${result.status})`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- enable ---
  agents
    .command('enable <agentId>')
    .description('Enable an agent (accept incoming requests)')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'enable');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- disable ---
  agents
    .command('disable <agentId>')
    .description('Disable an agent (reject requests, evict from memory)')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'disable');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- start ---
  agents
    .command('start <agentId>')
    .description('Hydrate the agent runner into memory (cache management; agents auto-hydrate on demand)')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'start');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- stop ---
  agents
    .command('stop <agentId>')
    .description('Evict the runner from memory (cache management; agent stays enabled)')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'stop');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- restart ---
  agents
    .command('restart <agentId>')
    .description('Evict and re-hydrate the runner (cache management)')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'restart');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- delete ---
  agents
    .command('delete <agentId>')
    .description('Delete an agent and all its data (must be disabled first)')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        await gateway.deleteAgent(agentId);
        console.log(`Agent deleted: ${agentId}`);
      } catch (error) {
        handleError(error);
      }
    });
};
