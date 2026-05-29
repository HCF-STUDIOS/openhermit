import { useTranslation, type MessageKey } from '../i18n';
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

const tabs: { id: ManageTab; labelKey: MessageKey }[] = [
  { id: 'basic', labelKey: 'manage.tab.basic' },
  { id: 'secrets', labelKey: 'manage.tab.secrets' },
  { id: 'channels', labelKey: 'manage.tab.channels' },
  { id: 'voice', labelKey: 'manage.tab.voice' },
  { id: 'skills', labelKey: 'manage.tab.skills' },
  { id: 'mcp', labelKey: 'manage.tab.mcp' },
  { id: 'schedules', labelKey: 'manage.tab.schedules' },
  { id: 'policies', labelKey: 'manage.tab.policies' },
  { id: 'approvals', labelKey: 'manage.tab.approvals' },
];

interface Props {
  tab: ManageTab;
  onTabChange: (tab: ManageTab) => void;
}

export function ManagePanel({ tab, onTabChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="manage">
      <div className="manage__tabs">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={`manage__tab${tab === entry.id ? ' active' : ''}`}
            onClick={() => onTabChange(entry.id)}
          >
            {t(entry.labelKey)}
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
