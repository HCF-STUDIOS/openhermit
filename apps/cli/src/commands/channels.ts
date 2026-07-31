import { spawn } from 'node:child_process';

import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

/**
 * Pull the bare package name out of an npm install spec.
 * Accepts `name`, `name@version`, `@scope/name`, `@scope/name@version`.
 * Rejects URL / git / file specs — `channelPackages` needs a name Node can `import()`.
 */
const parsePackageName = (spec: string): string => {
  if (spec.includes('://') || spec.startsWith('file:') || spec.startsWith('git:') || spec.startsWith('github:')) {
    throw new Error(
      `URL / git / file install specs aren't supported here — install with \`npm install -g <spec>\` ` +
      `and then \`hermit gateway config set channelPackages '["<package-name>"]'\` directly.`,
    );
  }
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash === -1) throw new Error(`Invalid scoped package spec: ${spec}`);
    const rest = spec.slice(slash + 1);
    const at = rest.indexOf('@');
    const name = at === -1 ? rest : rest.slice(0, at);
    return `${spec.slice(0, slash)}/${name}`;
  }
  const at = spec.indexOf('@');
  return at === -1 ? spec : spec.slice(0, at);
};

const runNpm = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('npm', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} exited with code ${code}`));
    });
  });

const readChannelPackages = async (): Promise<{ config: Record<string, unknown>; packages: string[] }> => {
  const gateway = createGateway();
  const { config } = await gateway.getGatewayConfig();
  const raw = (config as Record<string, unknown>).channelPackages;
  const packages = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  return { config: config as Record<string, unknown>, packages };
};

const writeChannelPackages = async (config: Record<string, unknown>, packages: string[]): Promise<void> => {
  const gateway = createGateway();
  await gateway.putGatewayConfig({ ...config, channelPackages: packages });
};

export const registerChannelsCommand = (program: Command): void => {
  const ch = program
    .command('channel')
    .alias('channels')
    .description('Install and manage channel plugin packages (npm-based).');

  ch.command('install <pkg>')
    .description(
      'Install a channel plugin: runs `npm install -g <pkg>` then appends the package name to ' +
      'the gateway `channelPackages` config. Restart the gateway to load it.',
    )
    .action(async (spec: string) => {
      try {
        const name = parsePackageName(spec);
        await runNpm(['install', '-g', spec]);
        const { config, packages } = await readChannelPackages();
        if (packages.includes(name)) {
          console.log(`\n${name} is already in channelPackages — config unchanged.`);
        } else {
          await writeChannelPackages(config, [...packages, name]);
          console.log(`\nAdded ${name} to channelPackages.`);
        }
        console.log('\nRestart the gateway for the change to take effect:');
        console.log('  hermit gateway stop && hermit gateway start');
      } catch (error) {
        handleError(error);
      }
    });

  ch.command('uninstall <pkg>')
    .alias('remove')
    .description(
      'Uninstall a channel plugin: removes it from the gateway `channelPackages` config and ' +
      'runs `npm uninstall -g <pkg>`. Restart the gateway to drop it.',
    )
    .action(async (spec: string) => {
      try {
        const name = parsePackageName(spec);
        const { config, packages } = await readChannelPackages();
        const removed = packages.includes(name);
        if (removed) {
          await writeChannelPackages(config, packages.filter((p) => p !== name));
        }
        await runNpm(['uninstall', '-g', name]);
        if (removed) {
          console.log(`\nRemoved ${name} from channelPackages.`);
        } else {
          console.log(`\n${name} was not in channelPackages — config unchanged.`);
        }
        console.log('\nRestart the gateway for the change to take effect:');
        console.log('  hermit gateway stop && hermit gateway start');
      } catch (error) {
        handleError(error);
      }
    });

  ch.command('list')
    .alias('ls')
    .description('List the npm packages currently registered as channel plugins.')
    .action(async () => {
      try {
        const { packages } = await readChannelPackages();
        if (packages.length === 0) {
          console.log('No channel packages registered.');
          console.log('Add one with: hermit channel install <pkg>');
          return;
        }
        for (const p of packages) console.log(p);
      } catch (error) {
        handleError(error);
      }
    });

  ch.command('enable <channelType>')
    .description(
      'Configure and enable a builtin channel on an agent.\n' +
      'Sets the bot token secret and starts the channel bridge.\n' +
      'Example: hermit channels enable telegram --agent <agentId> --token <bot-token>',
    )
    .requiredOption('--agent <agentId>', 'Agent ID')
    .requiredOption('--token <token>', 'Bot token or API key for the channel')
    .option('--mode <mode>', 'Connection mode: polling or webhook (telegram only)', 'polling')
    .action(async (channelType: string, opts: { agent: string; token: string; mode: string }) => {
      try {
        const gateway = createGateway();

        // 1. Find the channel record for this type.
        const channels = await gateway.listAgentChannels(opts.agent);
        const entry = channels.find((c) => c.channelType === channelType);
        if (!entry) {
          console.error(
            `No ${channelType} channel found on agent ${opts.agent}.\n` +
            `Builtin channels (telegram, discord, slack) are auto-seeded at agent create.\n` +
            `Run: hermit channels status --agent ${opts.agent}`,
          );
          process.exit(1);
        }

        // 2. Derive the secret key name from the channel's descriptor
        //    (e.g. TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN).
        const primarySecretKey = entry.secretKeys?.[0]?.key;
        if (!primarySecretKey) {
          console.error(
            `Channel "${channelType}" does not expose a secret key descriptor. ` +
            `Configure credentials via the gateway API directly.`,
          );
          process.exit(1);
        }

        // 3. Write the token as an agent secret.
        await gateway.setAgentSecret(opts.agent, primarySecretKey, opts.token);
        console.log(`  ✓ ${primarySecretKey} updated`);

        // 4. Enable the channel. The gateway auto-applies defaultConfig
        //    (which contains the ${{SECRET}} placeholder) when config is empty.
        //    For a mode override we merge into existing config.
        const configOverride =
          opts.mode !== 'polling' ? { ...entry.config, mode: opts.mode } : undefined;

        const result = await gateway.updateAgentChannel(opts.agent, entry.id, {
          enabled: true,
          ...(configOverride ? { config: configOverride } : {}),
        });

        if (result.error) {
          console.error(`\nBridge error: ${result.error}`);
          console.error('Check that the token is valid and try again.');
          process.exit(1);
        }

        console.log(`\n  Channel "${channelType}" is live on agent ${opts.agent}.`);
        if (result.runtimeStatus) console.log(`  Bridge status: ${result.runtimeStatus}`);
      } catch (error) {
        handleError(error);
      }
    });

  ch.command('status')
    .description('Show runtime status for all channels on an agent.')
    .requiredOption('--agent <agentId>', 'Agent ID')
    .action(async (opts: { agent: string }) => {
      try {
        const gateway = createGateway();
        const channels = await gateway.listAgentChannels(opts.agent);
        if (channels.length === 0) {
          console.log('No channels found on this agent.');
          return;
        }
        printTable(
          channels.map((c) => ({
            type: c.channelType,
            id: c.id,
            status: c.runtimeStatus,
            secrets: c.secretsSet ? 'set' : 'missing',
            error: c.lastError ?? '',
          })),
          [
            { key: 'type', label: 'Channel', width: 12 },
            { key: 'id', label: 'ID', width: 28 },
            { key: 'status', label: 'Status', width: 10 },
            { key: 'secrets', label: 'Secrets', width: 8 },
            { key: 'error', label: 'Error' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });
};
