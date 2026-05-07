import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { SecretsDialog } from './SecretsDialog';
import { SecurityDialog } from './SecurityDialog';
import { ConfigDialog } from './ConfigDialog';

interface FleetAgent {
  agentId: string;
  name?: string;
  status: 'active' | 'disabled';
  sessions24h: number;
  errors24h: number;
  lastActivity?: string;
  channels: string[];
  skillsCount: number;
  mcpCount: number;
}

interface SkillInfo {
  id: string;
  name?: string;
}

interface EffectiveSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: 'system' | 'workspace';
}

interface McpServerInfo {
  id: string;
  name: string;
  description: string;
  url: string;
  headerKeys?: string[];
}

const REFRESH_MS = 10_000;

const formatRelative = (iso?: string): string => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

export function FleetPanel() {
  const [fleet, setFleet] = useState<FleetAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [openMenu, setOpenMenu] = useState<{ agentId: string; top: number; right: number } | null>(null);
  const [secretsAgent, setSecretsAgent] = useState<string | null>(null);
  const [configAgent, setConfigAgent] = useState<string | null>(null);
  const [securityAgent, setSecurityAgent] = useState<string | null>(null);
  const [skillsAgent, setSkillsAgent] = useState<string | null>(null);
  const [mcpAgent, setMcpAgent] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<FleetAgent[]>('/api/admin/agents/fleet');
      setFleet(data);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (bulkOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [bulkOpen]);

  // Click outside / scroll / resize closes the action menu.
  useEffect(() => {
    if (!openMenu) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.fleet-actions') && !target?.closest('.fleet-actions__menu')) {
        setOpenMenu(null);
      }
    };
    const close = () => setOpenMenu(null);
    document.addEventListener('click', onClick);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openMenu]);

  const allSelected = fleet.length > 0 && selected.size === fleet.length;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(fleet.map((a) => a.agentId)));
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleAction = async (agentId: string, action: string) => {
    setOpenMenu(null);
    if (action === 'delete') {
      const ok = confirm(
        `Delete agent "${agentId}"?\n\n` +
        'This wipes its sessions, schedules, channels, secrets, skills, ' +
        'MCP assignments, and members. Workspace files on disk are NOT removed.\n\n' +
        'This cannot be undone.',
      );
      if (!ok) return;
    }
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/manage/${action}`, { method: 'POST' });
    } catch (err) {
      alert(`Failed to ${action} ${agentId}: ${(err as Error).message}`);
    }
    await load();
  };

  const totals = useMemo(() => ({
    active: fleet.filter((a) => a.status === 'active').length,
    sessions: fleet.reduce((acc, a) => acc + a.sessions24h, 0),
    errors: fleet.reduce((acc, a) => acc + a.errors24h, 0),
  }), [fleet]);

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>
          Agents
          <span className="fleet__sub">
            &nbsp;· {totals.active}/{fleet.length} active · {totals.sessions} sessions/24h · {totals.errors} errors/24h
          </span>
        </h2>
        <div className="panel__header-actions">
          {selected.size > 0 && (
            <>
              <span className="fleet__selection">{selected.size} selected</span>
              <button className="btn btn--primary btn--sm" onClick={() => setBulkOpen(true)}>
                Bulk skill…
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Refresh
          </button>
          <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
            Create Agent
          </button>
        </div>
      </div>

      {loading && fleet.length === 0 && (
        <p className="agent-list__empty">Loading agents…</p>
      )}

      {!loading && error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && fleet.length === 0 && (
        <p className="agent-list__empty">No agents yet. Create one to get started.</p>
      )}

      {fleet.length > 0 && (
        <>
        <div className="fleet-table-wrap">
        <table className="fleet-table">
          <thead>
            <tr>
              <th className="fleet-table__check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th>Agent</th>
              <th>Status</th>
              <th>Last activity</th>
              <th className="fleet-table__num">Sessions 24h</th>
              <th className="fleet-table__num">Errors 24h</th>
              <th className="fleet-table__actions"></th>
            </tr>
          </thead>
          <tbody>
            {fleet.map((a) => (
              <tr key={a.agentId} className={selected.has(a.agentId) ? 'fleet-row--selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(a.agentId)}
                    onChange={() => toggleOne(a.agentId)}
                    aria-label={`Select ${a.agentId}`}
                  />
                </td>
                <td>
                  <div className="fleet-cell-agent">
                    <span className="fleet-cell-agent__id">{a.agentId}</span>
                    {a.name && <span className="fleet-cell-agent__name">{a.name}</span>}
                  </div>
                </td>
                <td>
                  <span className={`badge badge--${a.status === 'active' ? 'active' : 'stopped'}`}>{a.status}</span>
                </td>
                <td className="fleet-cell-relative">{formatRelative(a.lastActivity)}</td>
                <td className="fleet-table__num">{a.sessions24h}</td>
                <td className={`fleet-table__num${a.errors24h > 0 ? ' fleet-cell-error' : ''}`}>
                  {a.errors24h}
                </td>
                <td className="fleet-table__actions">
                  <div className="fleet-actions">
                    <button
                      className="btn btn--ghost btn--sm fleet-actions__trigger"
                      aria-label={`Manage ${a.agentId}`}
                      aria-expanded={openMenu?.agentId === a.agentId}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (openMenu?.agentId === a.agentId) {
                          setOpenMenu(null);
                          return;
                        }
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setOpenMenu({
                          agentId: a.agentId,
                          top: rect.bottom + 4,
                          right: window.innerWidth - rect.right,
                        });
                      }}
                    >
                      ⋮
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        <div className="fleet-cards">
          {fleet.map((a) => (
            <div
              key={a.agentId}
              className={`fleet-card${selected.has(a.agentId) ? ' fleet-card--selected' : ''}`}
            >
              <div className="fleet-card__top">
                <input
                  type="checkbox"
                  checked={selected.has(a.agentId)}
                  onChange={() => toggleOne(a.agentId)}
                  aria-label={`Select ${a.agentId}`}
                />
                <div className="fleet-card__heading">
                  <span className="fleet-card__id">{a.agentId}</span>
                  {a.name && <span className="fleet-card__name">{a.name}</span>}
                </div>
                <span className={`badge badge--${a.status}`}>{a.status}</span>
                <button
                  className="btn btn--ghost btn--sm fleet-actions__trigger"
                  aria-label={`Manage ${a.agentId}`}
                  aria-expanded={openMenu?.agentId === a.agentId}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openMenu?.agentId === a.agentId) {
                      setOpenMenu(null);
                      return;
                    }
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setOpenMenu({
                      agentId: a.agentId,
                      top: rect.bottom + 4,
                      right: window.innerWidth - rect.right,
                    });
                  }}
                >
                  ⋮
                </button>
              </div>
              <dl className="fleet-card__stats">
                <div>
                  <dt>Last activity</dt>
                  <dd>{formatRelative(a.lastActivity)}</dd>
                </div>
                <div>
                  <dt>Sessions 24h</dt>
                  <dd>{a.sessions24h}</dd>
                </div>
                <div>
                  <dt>Errors 24h</dt>
                  <dd className={a.errors24h > 0 ? 'fleet-cell-error' : ''}>{a.errors24h}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
        </>
      )}

      <dialog ref={dialogRef} className="dialog">
        <BulkSkillDialog
          selected={selected}
          totalAgents={fleet.length}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            void load();
          }}
        />
      </dialog>

      {openMenu && createPortal(
        <FleetActionsMenu
          agent={fleet.find((a) => a.agentId === openMenu.agentId)}
          top={openMenu.top}
          right={openMenu.right}
          onAction={handleAction}
          onConfig={(id) => { setOpenMenu(null); setConfigAgent(id); }}
          onSkills={(id) => { setOpenMenu(null); setSkillsAgent(id); }}
          onMcp={(id) => { setOpenMenu(null); setMcpAgent(id); }}
          onSecrets={(id) => { setOpenMenu(null); setSecretsAgent(id); }}
          onSecurity={(id) => { setOpenMenu(null); setSecurityAgent(id); }}
        />,
        document.body,
      )}

      {showCreate && <CreateAgentDialog onClose={() => setShowCreate(false)} onCreated={load} />}
      {secretsAgent && <SecretsDialog agentId={secretsAgent} onClose={() => setSecretsAgent(null)} />}
      {securityAgent && <SecurityDialog agentId={securityAgent} onClose={() => setSecurityAgent(null)} />}
      {configAgent && <ConfigDialog agentId={configAgent} onClose={() => setConfigAgent(null)} />}
      {skillsAgent && <AgentSkillsDialog agentId={skillsAgent} onClose={() => setSkillsAgent(null)} />}
      {mcpAgent && <AgentMcpDialog agentId={mcpAgent} onClose={() => setMcpAgent(null)} />}
    </div>
  );
}

function FleetActionsMenu({
  agent,
  top,
  right,
  onAction,
  onConfig,
  onSkills,
  onMcp,
  onSecrets,
  onSecurity,
}: {
  agent: FleetAgent | undefined;
  top: number;
  right: number;
  onAction: (agentId: string, action: string) => void;
  onConfig: (agentId: string) => void;
  onSkills: (agentId: string) => void;
  onMcp: (agentId: string) => void;
  onSecrets: (agentId: string) => void;
  onSecurity: (agentId: string) => void;
}) {
  if (!agent) return null;
  return (
    <div
      className="fleet-actions__menu"
      role="menu"
      style={{ position: 'fixed', top, right }}
      onClick={(e) => e.stopPropagation()}
    >
      {agent.status === 'disabled' ? (
        <button role="menuitem" onClick={() => onAction(agent.agentId, 'enable')}>Enable</button>
      ) : (
        <>
          <button role="menuitem" onClick={() => onAction(agent.agentId, 'restart')}>Reload</button>
          <button role="menuitem" onClick={() => onAction(agent.agentId, 'disable')}>Disable</button>
        </>
      )}
      <div className="fleet-actions__divider" />
      <button role="menuitem" onClick={() => onConfig(agent.agentId)}>Config</button>
      <button role="menuitem" onClick={() => onSkills(agent.agentId)}>Skills</button>
      <button role="menuitem" onClick={() => onMcp(agent.agentId)}>MCP</button>
      <button role="menuitem" onClick={() => onSecrets(agent.agentId)}>Secrets</button>
      <button role="menuitem" onClick={() => onSecurity(agent.agentId)}>Security</button>
      {agent.status === 'disabled' && (
        <>
          <div className="fleet-actions__divider" />
          <button
            role="menuitem"
            className="fleet-actions__danger"
            onClick={() => onAction(agent.agentId, 'delete')}
          >
            Delete…
          </button>
        </>
      )}
    </div>
  );
}

function BulkSkillDialog({
  selected,
  totalAgents,
  onClose,
  onDone,
}: {
  selected: Set<string>;
  totalAgents: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillId, setSkillId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allSelected = selected.size === totalAgents && totalAgents > 0;

  useEffect(() => {
    void api<SkillInfo[]>('/api/admin/skills').then(setSkills).catch((e) => setError((e as Error).message));
  }, []);

  const apply = async (action: 'enable' | 'disable') => {
    if (!skillId) return;
    setBusy(true);
    setError('');
    try {
      if (allSelected) {
        await api(`/api/admin/skills/${encodeURIComponent(skillId)}/${action}`, {
          method: 'POST',
          body: { agentId: '*' },
        });
      } else {
        for (const id of selected) {
          await api(`/api/admin/skills/${encodeURIComponent(skillId)}/${action}`, {
            method: 'POST',
            body: { agentId: id },
          });
        }
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog__inner">
      <h3>Bulk skill action</h3>
      <p className="dialog__hint">
        {allSelected
          ? `Affects all ${totalAgents} agents (uses wildcard '*' assignment).`
          : `Affects ${selected.size} selected agent${selected.size === 1 ? '' : 's'}.`}
      </p>

      <label className="field">
        <span>Skill</span>
        <select value={skillId} onChange={(e) => setSkillId(e.target.value)} disabled={busy}>
          <option value="">— pick a skill —</option>
          {skills.map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.id}</option>
          ))}
        </select>
      </label>

      {error && <p className="dialog__error">{error}</p>}

      <div className="dialog__actions">
        <button
          className="btn btn--primary btn--sm"
          onClick={() => void apply('enable')}
          disabled={!skillId || busy}
        >
          Enable
        </button>
        <button
          className="btn btn--sm"
          onClick={() => void apply('disable')}
          disabled={!skillId || busy}
        >
          Disable
        </button>
        <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface SandboxPresetsResponse {
  presets: Record<string, { type: string; config: Record<string, unknown> }>;
  autoProvisionSandbox: string | null;
}

const SANDBOX_DEFAULT = '__default__';
const SANDBOX_NONE = '__none__';

function CreateAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [sandbox, setSandbox] = useState<string>(SANDBOX_DEFAULT);
  const [access, setAccess] = useState<'public' | 'protected' | 'private'>('public');
  const [presetsInfo, setPresetsInfo] = useState<SandboxPresetsResponse | null>(null);

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<SandboxPresetsResponse>('/api/sandbox-presets')
      .then((data) => setPresetsInfo(data))
      .catch(() => setPresetsInfo({ presets: {}, autoProvisionSandbox: null }));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId.trim()) return;
    let sandboxField: { sandbox?: string | null } = {};
    if (sandbox === SANDBOX_NONE) {
      sandboxField = { sandbox: null };
    } else if (sandbox !== SANDBOX_DEFAULT) {
      sandboxField = { sandbox };
    }
    try {
      await api('/api/agents', {
        method: 'POST',
        body: {
          agentId: agentId.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(owner.trim() ? { ownerUserId: owner.trim() } : {}),
          access,
          ...sandboxField,
        },
      });
      onClose();
      onCreated();
    } catch (err) {
      alert(`Failed to create agent: ${(err as Error).message}`);
    }
  };

  const presetNames = presetsInfo ? Object.keys(presetsInfo.presets) : [];
  const defaultLabel = presetsInfo?.autoProvisionSandbox
    ? `Default (${presetsInfo.autoProvisionSandbox})`
    : 'Default (none)';

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form className="dialog__form" onSubmit={handleSubmit}>
        <h3>Create Agent</h3>
        <label className="field">
          <span className="field__label">Agent ID</span>
          <input className="field__input" required value={agentId} onChange={(e) => setAgentId(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Name (optional)</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Owner User ID (optional)</span>
          <input className="field__input" placeholder="e.g. usr-owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Access</span>
          <select
            className="field__input"
            value={access}
            onChange={(e) => setAccess(e.target.value as 'public' | 'protected' | 'private')}
          >
            <option value="public">Public — anyone can join</option>
            <option value="protected">Protected — token required (set via Security after create)</option>
            <option value="private">Private — invite only</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Sandbox</span>
          <select className="field__input" value={sandbox} onChange={(e) => setSandbox(e.target.value)}>
            <option value={SANDBOX_DEFAULT}>{defaultLabel}</option>
            {presetNames.map((p) => (
              <option key={p} value={p}>
                {p} ({presetsInfo?.presets[p].type})
              </option>
            ))}
            <option value={SANDBOX_NONE}>None (skip provisioning)</option>
          </select>
        </label>
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="submit">Create</button>
        </div>
      </form>
    </dialog>
  );
}

function AgentSkillsDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [skills, setSkills] = useState<EffectiveSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<EffectiveSkill[]>(`/api/agents/${encodeURIComponent(agentId)}/skills`)
      .then((data) => { setSkills(data); setLoading(false); })
      .catch((err) => { setError((err as Error).message); setLoading(false); });
  }, [agentId]);

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Active Skills — {agentId}</h3>

        {loading && <p className="secrets-empty">Loading…</p>}
        {error && <p className="config-error">{error}</p>}

        {!loading && !error && skills.length === 0 && (
          <p className="secrets-empty">No skills active for this agent.</p>
        )}

        {skills.map((s) => (
          <div className="skill-card" key={s.id}>
            <div className="skill-card__info">
              <span className="skill-card__name">{s.name}</span>
              <span className="skill-card__id">{s.id}</span>
              <span className={`badge badge--${s.source === 'system' ? 'running' : 'stopped'}`}>
                {s.source}
              </span>
              <div className="skill-card__desc">{s.description}</div>
            </div>
          </div>
        ))}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}

function AgentMcpDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<McpServerInfo[]>(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`)
      .then((data) => { setServers(data); setLoading(false); })
      .catch((err) => { setError((err as Error).message); setLoading(false); });
  }, [agentId]);

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>MCP Servers — {agentId}</h3>

        {loading && <p className="secrets-empty">Loading…</p>}
        {error && <p className="config-error">{error}</p>}

        {!loading && !error && servers.length === 0 && (
          <p className="secrets-empty">No MCP servers enabled for this agent.</p>
        )}

        {servers.map((s) => (
          <div className="skill-card" key={s.id}>
            <div className="skill-card__info">
              <span className="skill-card__name">{s.name}</span>
              <span className="skill-card__id">{s.id}</span>
              <div className="skill-card__desc">{s.description}</div>
              <div className="skill-card__path">{s.url}</div>
              {s.headerKeys && s.headerKeys.length > 0 && (
                <div className="skill-card__path">
                  Auth headers: {s.headerKeys.join(', ')}
                </div>
              )}
            </div>
          </div>
        ))}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
