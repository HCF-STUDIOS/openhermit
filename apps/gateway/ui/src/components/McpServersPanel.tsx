import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Pagination, usePagination } from './Pagination';

interface McpServerInfo {
  id: string;
  name: string;
  description: string;
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface AgentMcpAssignment {
  agentId: string;
  mcpServerId: string;
  enabled: boolean;
  createdAt: string;
}

export function McpServersPanel() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editServer, setEditServer] = useState<McpServerInfo | null>(null);
  const [assignServer, setAssignServer] = useState<McpServerInfo | null>(null);

  const load = useCallback(async () => {
    try {
      setServers(await api<McpServerInfo[]>('/api/admin/mcp-servers'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const { page, setPage, pageCount, pageItems, total, pageSize } = usePagination(servers);

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete MCP server "${id}"? This will also remove all agent assignments.`)) return;
    try {
      await api(`/api/admin/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
    await load();
  };

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>MCP Servers</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
          Add Server
        </button>
      </div>

      {loading && servers.length === 0 && (
        <p className="agent-list__empty">Loading MCP servers…</p>
      )}

      {!loading && error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && servers.length === 0 && (
        <p className="agent-list__empty">No MCP servers registered. Add one to get started.</p>
      )}

      <div className="skill-list">
        {pageItems.map((s) => (
          <div className="skill-card" key={s.id}>
            <div className="skill-card__info">
              <span className="skill-card__name">{s.name}</span>
              <span className="skill-card__id">{s.id}</span>
              <div className="skill-card__desc">{s.description}</div>
              <div className="skill-card__path">{s.url}</div>
            </div>
            <div className="skill-card__actions">
              <button className="btn btn--sm" onClick={() => setAssignServer(s)}>
                Agents
              </button>
              <button className="btn btn--sm" onClick={() => setEditServer(s)}>
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
        <McpServerFormDialog
          onClose={() => setShowCreate(false)}
          onSaved={load}
        />
      )}
      {editServer && (
        <McpServerFormDialog
          server={editServer}
          onClose={() => setEditServer(null)}
          onSaved={load}
        />
      )}
      {assignServer && (
        <McpAssignmentsDialog
          server={assignServer}
          onClose={() => setAssignServer(null)}
        />
      )}
    </div>
  );
}

// ── Create / Edit dialog ──────────────────────────────────────────────────

function McpServerFormDialog({
  server,
  onClose,
  onSaved,
}: {
  server?: McpServerInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState(server?.id ?? '');
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [headersText, setHeadersText] = useState(
    server?.headers ? JSON.stringify(server.headers, null, 2) : '',
  );

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !name.trim() || !description.trim() || !url.trim()) return;

    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        headers = JSON.parse(headersText.trim());
      } catch {
        alert('Headers must be valid JSON (e.g. {"Authorization": "Bearer ..."})');
        return;
      }
    }

    try {
      await api('/api/admin/mcp-servers', {
        method: 'POST',
        body: {
          id: id.trim(),
          name: name.trim(),
          description: description.trim(),
          url: url.trim(),
          ...(headers ? { headers } : {}),
        },
      });
      onClose();
      onSaved();
    } catch (err) {
      alert(`Failed to save: ${(err as Error).message}`);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form className="dialog__form" onSubmit={handleSubmit}>
        <h3>{server ? 'Edit MCP Server' : 'Add MCP Server'}</h3>
        <label className="field">
          <span className="field__label">Server ID</span>
          <input
            className="field__input"
            required
            placeholder="e.g. github-mcp"
            value={id}
            readOnly={!!server}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            required
            placeholder="e.g. GitHub MCP Server"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Description</span>
          <input
            className="field__input"
            required
            placeholder="What tools does this server provide?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">URL</span>
          <input
            className="field__input"
            required
            type="url"
            placeholder="https://mcp.example.com/sse"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Headers (JSON, optional)</span>
          <textarea
            className="field__input"
            rows={3}
            placeholder='{"Authorization": "Bearer ..."}'
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
          />
        </label>
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="submit">{server ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </dialog>
  );
}

// ── Agent assignments dialog ──────────────────────────────────────────────

function McpAssignmentsDialog({
  server,
  onClose,
}: {
  server: McpServerInfo;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [assignments, setAssignments] = useState<AgentMcpAssignment[]>([]);
  const [newAgentId, setNewAgentId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const all = await api<AgentMcpAssignment[]>('/api/admin/mcp-servers/assignments');
      setAssignments(all.filter((a) => a.mcpServerId === server.id));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [server.id]);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  useEffect(() => { void load(); }, [load]);

  const handleEnable = async (agentId: string) => {
    try {
      await api(`/api/admin/mcp-servers/${encodeURIComponent(server.id)}/enable`, {
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
      await api(`/api/admin/mcp-servers/${encodeURIComponent(server.id)}/disable`, {
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
        <h3>Agent Assignments — {server.name}</h3>
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
