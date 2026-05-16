import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Command } from 'commander';
import { loadEnv } from '@openhermit/shared';

import { registerChatCommand } from './commands/chat.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerWebCommand } from './commands/web.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerConfigCommand } from './commands/config.js';
import { registerSchedulesCommand } from './commands/schedules.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerSandboxCommand } from './commands/sandbox.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerInstructionsCommand } from './commands/instructions.js';
import { registerChannelsCommand } from './commands/channels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

await loadEnv();

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('hermit')
  .description('OpenHermit — multi-agent platform CLI')
  .version(pkg.version);

registerSetupCommand(program);
registerChatCommand(program);
registerAgentsCommand(program);
registerGatewayCommand(program);
registerWebCommand(program);
registerConfigCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerLogsCommand(program);
registerSchedulesCommand(program);
registerSkillsCommand(program);
registerSandboxCommand(program);
registerMcpCommand(program);
registerStatsCommand(program);
registerInstructionsCommand(program);
registerChannelsCommand(program);

await program.parseAsync(process.argv);
