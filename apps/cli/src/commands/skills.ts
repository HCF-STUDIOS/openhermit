import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter } from '@openhermit/agent/skills';
import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

export const registerSkillsCommand = (program: Command): void => {
  const skills = program
    .command('skills')
    .description('Manage skills');

  /** Resolve --agent | --all into the wildcard-or-id the API expects. */
  const resolveTarget = (opts: { agent?: string; all?: boolean }): string => {
    if (opts.agent && opts.all) {
      console.error('Pass either --agent <id> or --all, not both.');
      process.exit(1);
    }
    if (opts.all) return '*';
    if (opts.agent) return opts.agent;
    console.error('Pass --agent <id> or --all.');
    process.exit(1);
  };
  const targetLabel = (target: string): string =>
    target === '*' ? 'all agents' : `agent ${target}`;

  skills
    .command('list')
    .description('List all skills in the registry')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = (await gateway.listSkills()) as any[];
        if (list.length === 0) {
          console.log('No skills registered.');
          return;
        }
        printTable(
          list.map((s: any) => ({
            id: s.id,
            name: s.name ?? '',
            source: s.source ?? '',
            description: s.description
              ? (s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description)
              : '',
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'source', label: 'Source', width: 10 },
            { key: 'description', label: 'Description' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('assignments')
    .description('List skill assignments (which skills are enabled for which agents)')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = await gateway.listSkillAssignments();
        if (list.length === 0) {
          console.log('No skill assignments.');
          return;
        }
        printTable(
          list.map((a) => ({
            agentId: a.agentId,
            skillId: a.skillId,
            enabled: a.enabled ? 'yes' : 'no',
          })),
          [
            { key: 'agentId', label: 'Agent', width: 16 },
            { key: 'skillId', label: 'Skill' },
            { key: 'enabled', label: 'Enabled', width: 8 },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('enable')
    .description('Enable a skill. Targets one agent (--agent) or every agent (--all).')
    .argument('<skillId>', 'Skill ID')
    .option('--agent <id>', 'Agent ID')
    .option('--all', 'Apply to every agent (writes a wildcard assignment row)')
    .action(async (skillId: string, opts: { agent?: string; all?: boolean }) => {
      try {
        const target = resolveTarget(opts);
        const gateway = createGateway();
        await gateway.enableSkill(skillId, target);
        console.log(`Enabled skill ${skillId} for ${targetLabel(target)}.`);
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('disable')
    .description('Disable a skill. Targets one agent (--agent) or every agent (--all).')
    .argument('<skillId>', 'Skill ID')
    .option('--agent <id>', 'Agent ID')
    .option('--all', 'Apply to every agent (removes the wildcard assignment row)')
    .action(async (skillId: string, opts: { agent?: string; all?: boolean }) => {
      try {
        const target = resolveTarget(opts);
        const gateway = createGateway();
        await gateway.disableSkill(skillId, target);
        console.log(`Disabled skill ${skillId} for ${targetLabel(target)}.`);
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('scan')
    .description('Scan the gateway skills directory for skill manifests')
    .action(async () => {
      try {
        const gateway = createGateway();
        const found = (await gateway.scanSkills()) as any[];
        if (found.length === 0) {
          console.log('No skills found.');
          return;
        }
        printTable(
          found.map((s: any) => ({
            id: s.id,
            name: s.name ?? '',
            path: s.path ?? '',
            description: s.description
              ? (s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description)
              : '',
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'path', label: 'Path' },
            { key: 'description', label: 'Description' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('register <skillId>')
    .description('Register a skill in the global registry')
    .requiredOption('--path <path>', 'Filesystem path to skill directory')
    .option('--name <name>', 'Display name (default: from SKILL.md frontmatter)')
    .option('--description <text>', 'Skill description (default: from SKILL.md frontmatter)')
    .action(async (skillId: string, opts: { name?: string; description?: string; path: string }) => {
      try {
        let name = opts.name;
        let description = opts.description;

        if (!name || !description) {
          const skillMdPath = path.join(opts.path, 'SKILL.md');
          let fm: Record<string, string> = {};
          try {
            fm = parseFrontmatter(await readFile(skillMdPath, 'utf8'));
          } catch {
            console.error(
              `Could not read ${skillMdPath}. Pass --name and --description explicitly, or ensure SKILL.md exists.`,
            );
            process.exit(1);
          }
          name ??= fm.name;
          description ??= fm.description;
        }

        if (!name || !description) {
          console.error(
            'Missing name or description. Provide them via flags or SKILL.md frontmatter.',
          );
          process.exit(1);
        }

        const gateway = createGateway();
        await gateway.registerSkill({
          id: skillId,
          name,
          description,
          path: opts.path,
        });
        console.log(`Registered skill ${skillId}.`);
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('sync [skillId]')
    .description(
      'Re-read SKILL.md from disk and refresh DB + running agents. ' +
        'Pass a skill ID to sync one; omit it to sync every registered system skill.',
    )
    .action(async (skillId: string | undefined) => {
      try {
        const gateway = createGateway();
        const { results, agentsRefreshed } = await gateway.syncSkills(skillId);

        if (results.length === 0) {
          console.log('No skills to sync.');
          return;
        }

        const formatChanges = (
          changes?: Record<string, { from: string; to: string }>,
        ): string => {
          if (!changes) return '';
          const parts: string[] = [];
          for (const [field, { from, to }] of Object.entries(changes)) {
            const fromShort = from.length > 30 ? from.slice(0, 30) + '…' : from;
            const toShort = to.length > 30 ? to.slice(0, 30) + '…' : to;
            parts.push(`${field}: "${fromShort}" → "${toShort}"`);
          }
          return parts.join('; ');
        };

        printTable(
          results.map((r) => ({
            id: r.id,
            action: r.action,
            changes: formatChanges(r.changes),
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'action', label: 'Action', width: 18 },
            { key: 'changes', label: 'Changes' },
          ],
        );

        const updated = results.filter((r) => r.action === 'updated').length;
        const missing = results.filter((r) => r.action === 'missing_on_disk').length;
        const summary = [
          `${updated} updated`,
          `${results.length - updated - missing} unchanged`,
        ];
        if (missing > 0) summary.push(`${missing} missing on disk`);
        summary.push(`${agentsRefreshed} running agent(s) refreshed`);
        console.log('\n' + summary.join(', ') + '.');
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('delete <skillId>')
    .description('Delete a skill from the global registry')
    .action(async (skillId: string) => {
      try {
        const gateway = createGateway();
        await gateway.deleteSkill(skillId);
        console.log(`Deleted skill ${skillId}.`);
      } catch (error) {
        handleError(error);
      }
    });
};
