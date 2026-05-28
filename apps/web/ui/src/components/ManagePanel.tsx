import { BasicPanel } from './BasicPanel';
import { SecretsPanel } from './SecretsPanel';
import { SkillsPanel } from './SkillsPanel';
import { McpPanel } from './McpPanel';
import { SchedulesPanel } from './SchedulesPanel';
import { ChannelsPanel } from './ChannelsPanel';
import { PoliciesPanel } from './PoliciesPanel';
import { ApprovalsPanel } from './ApprovalsPanel';
import { VoicePanel } from './VoicePanel';

export type ManageTab =
  | 'basic'
  | 'secrets'
  | 'skills'
  | 'mcp'
  | 'schedules'
  | 'channels'
  | 'voice'
  | 'policies'
  | 'approvals';

const tabs: { id: ManageTab; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'channels', label: 'Channels' },
  { id: 'voice', label: 'Voice' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'policies', label: 'Policies' },
  { id: 'approvals', label: 'Approvals' },
];

interface Props {
  tab: ManageTab;
  onTabChange: (tab: ManageTab) => void;
}

export function ManagePanel({ tab, onTabChange }: Props) {
  return (
    <div className="manage">
      <div className="manage__tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`manage__tab${tab === t.id ? ' active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="manage__content">
        {tab === 'basic' && <BasicPanel />}
        {tab === 'secrets' && <SecretsPanel />}
        {tab === 'skills' && <SkillsPanel />}
        {tab === 'mcp' && <McpPanel />}
        {tab === 'schedules' && <SchedulesPanel />}
        {tab === 'channels' && <ChannelsPanel />}
        {tab === 'voice' && <VoicePanel />}
        {tab === 'policies' && <PoliciesPanel />}
        {tab === 'approvals' && <ApprovalsPanel />}
      </div>
    </div>
  );
}
