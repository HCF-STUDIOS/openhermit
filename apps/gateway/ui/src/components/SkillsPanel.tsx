import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Pagination, usePagination } from './Pagination';

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface AgentSkillAssignment {
  agentId: string;
  skillId: string;
  enabled: boolean;
  createdAt: string;
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editSkill, setEditSkill] = useState<SkillInfo | null>(null);
  const [assignSkill, setAssignSkill] = useState<SkillInfo | null>(null);

  const load = useCallback(async () => {
    try {
      setSkills(await api<SkillInfo[]>('/api/admin/skills'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const { page, setPage, pageCount, pageItems, total, pageSize } = usePagination(skills);

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete skill "${id}"? This will also remove all agent assignments.`)) return;
    try {
      await api(`/api/admin/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
    await load();
  };

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Skills</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
          Register Skill
        </button>
      </div>

      {loading && skills.length === 0 && (
        <p className="agent-list__empty">Loading skills…</p>
      )}

      {!loading && error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && skills.length === 0 && (
        <p className="agent-list__empty">No skills registered. Register one to get started.</p>
      )}

      <div className="skill-list">
        {pageItems.map((s) => (
          <div className="skill-card" key={s.id}>
            <div className="skill-card__info">
              <span className="skill-card__name">{s.name}</span>
              <span className="skill-card__id">{s.id}</span>
              <div className="skill-card__desc">{s.description}</div>
              <div className="skill-card__path">{s.path}</div>
            </div>
            <div className="skill-card__actions">
              <button className="btn btn--sm" onClick={() => setAssignSkill(s)}>
                Agents
              </button>
              <button className="btn btn--sm" onClick={() => setEditSkill(s)}>
                Edit
              </button>
              <button className="btn btn--sm btn--danger" onClick={() => handleDelete(s.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} />

      {showCreate && (
        <SkillFormDialog
          onClose={() => setShowCreate(false)}
          onSaved={load}
        />
      )}
      {editSkill && (
        <SkillFormDialog
          skill={editSkill}
          onClose={() => setEditSkill(null)}
          onSaved={load}
        />
      )}
      {assignSkill && (
        <AssignmentsDialog
          skill={assignSkill}
          onClose={() => setAssignSkill(null)}
        />
      )}
    </div>
  );
}

// ── Create / Edit dialog ──────────────────────────────────────────────────

interface ScannedSkill {
  id: string;
  name: string;
  description: string;
  path: string;
}

function SkillFormDialog({
  skill,
  onClose,
  onSaved,
}: {
  skill?: SkillInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState(skill?.id ?? '');
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [skillPath, setSkillPath] = useState(skill?.path ?? '');
  const [scannedSkills, setScannedSkills] = useState<ScannedSkill[]>([]);

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    if (skill) return;
    api<ScannedSkill[]>('/api/admin/skills/scan').then(setScannedSkills).catch(() => {});
  }, [skill]);

  const handleSelectScanned = (selectedId: string) => {
    const found = scannedSkills.find((s) => s.id === selectedId);
    if (found) {
      setId(found.id);
      setName(found.name);
      setDescription(found.description);
      setSkillPath(found.path);
    } else {
      setId(selectedId);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !name.trim() || !description.trim() || !skillPath.trim()) return;
    try {
      await api('/api/admin/skills', {
        method: 'POST',
        body: {
          id: id.trim(),
          name: name.trim(),
          description: description.trim(),
          path: skillPath.trim(),
        },
      });
      onClose();
      onSaved();
    } catch (err) {
      alert(`Failed to save skill: ${(err as Error).message}`);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form className="dialog__form" onSubmit={handleSubmit}>
        <h3>{skill ? 'Edit Skill' : 'Register Skill'}</h3>
        <label className="field">
          <span className="field__label">Skill ID</span>
          {skill ? (
            <input className="field__input" value={id} readOnly />
          ) : scannedSkills.length > 0 ? (
            <select
              className="field__input"
              required
              value={id}
              onChange={(e) => handleSelectScanned(e.target.value)}
            >
              <option value="">— Select a skill —</option>
              {scannedSkills.map((s) => (
                <option key={s.id} value={s.id}>{s.id} — {s.name}</option>
              ))}
            </select>
          ) : (
            <input
              className="field__input"
              required
              placeholder="e.g. deploy-staging"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          )}
        </label>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            required
            placeholder="e.g. Deploy Staging"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Description</span>
          <input
            className="field__input"
            required
            placeholder="One-line summary for the system prompt index"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Path (host filesystem)</span>
          <input
            className="field__input"
            required
            placeholder="e.g. /home/user/.openhermit/skills/deploy-staging"
            value={skillPath}
            onChange={(e) => setSkillPath(e.target.value)}
          />
        </label>
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="submit">{skill ? 'Save' : 'Register'}</button>
        </div>
      </form>
    </dialog>
  );
}

// ── Agent assignments dialog ──────────────────────────────────────────────

function AssignmentsDialog({
  skill,
  onClose,
}: {
  skill: SkillInfo;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [assignments, setAssignments] = useState<AgentSkillAssignment[]>([]);
  const [newAgentId, setNewAgentId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const all = await api<AgentSkillAssignment[]>('/api/admin/skills/assignments');
      setAssignments(all.filter((a) => a.skillId === skill.id));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [skill.id]);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  useEffect(() => { void load(); }, [load]);

  const handleEnable = async (agentId: string) => {
    try {
      await api(`/api/admin/skills/${encodeURIComponent(skill.id)}/enable`, {
        method: 'POST',
        body: { agentId },
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDisable = async (agentId: string) => {
    try {
      await api(`/api/admin/skills/${encodeURIComponent(skill.id)}/disable`, {
        method: 'POST',
        body: { agentId },
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAdd = async () => {
    const id = newAgentId.trim();
    if (!id) return;
    await handleEnable(id);
    setNewAgentId('');
  };

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Agent Assignments — {skill.name}</h3>
        <p className="skill-assign__hint">
          Use <code>*</code> to enable for all agents.
        </p>

        {assignments.length === 0 && !error && (
          <p className="secrets-empty">No agents assigned yet.</p>
        )}

        {assignments.map((a) => (
          <div className="assign-row" key={a.agentId}>
            <span className="assign-row__agent">{a.agentId}</span>
            <span className={`badge badge--${a.enabled ? 'running' : 'stopped'}`}>
              {a.enabled ? 'enabled' : 'disabled'}
            </span>
            <div className="assign-row__actions">
              {a.enabled ? (
                <button className="btn btn--sm" onClick={() => handleDisable(a.agentId)}>
                  Disable
                </button>
              ) : (
                <button className="btn btn--sm" onClick={() => handleEnable(a.agentId)}>
                  Enable
                </button>
              )}
            </div>
          </div>
        ))}

        <div className="secrets-add">
          <input
            className="field__input field__input--inline"
            placeholder="Agent ID or * for all"
            value={newAgentId}
            onChange={(e) => setNewAgentId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
          />
          <button className="btn btn--sm btn--primary" type="button" onClick={handleAdd}>
            Enable
          </button>
        </div>

        {error && <p className="config-error">{error}</p>}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
