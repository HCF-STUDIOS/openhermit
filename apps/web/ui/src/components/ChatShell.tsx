import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AgentWsClient, fetchAgentInfo, getDisplayName, getUserId, type Connection, type SessionSummary, type HistoryMessage, type OutboundEvent } from '../api';
import { SessionList } from './SessionList';
import { ChatMessages, type ChatItem } from './ChatMessages';
import { Composer } from './Composer';
// ManagePanel only needed when user opens /manage — keep it out of the
// hot chat path.
const ManagePanel = lazy(() => import('./ManagePanel').then((m) => ({ default: m.ManagePanel })));

type View = 'chat' | 'manage';
type ManageTab = 'basic' | 'secrets' | 'skills' | 'mcp' | 'schedules' | 'channels' | 'policies';

const createSessionId = () =>
  `web:${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

const MANAGE_TABS: ManageTab[] = ['basic', 'secrets', 'channels', 'skills', 'mcp', 'schedules', 'policies'];

type Route =
  | { view: 'chat'; sessionId: string | null }
  | { view: 'manage'; tab: ManageTab };

const parseRoute = (pathname: string): Route => {
  if (pathname.startsWith('/manage')) {
    const tab = pathname.split('/')[2] as ManageTab | undefined;
    return { view: 'manage', tab: MANAGE_TABS.includes(tab!) ? tab! : 'basic' };
  }
  if (pathname.startsWith('/chat/')) {
    const sessionId = decodeURIComponent(pathname.slice(6));
    return sessionId ? { view: 'chat', sessionId } : { view: 'chat', sessionId: null };
  }
  return { view: 'chat', sessionId: null };
};

const routeToPath = (route: Route): string => {
  if (route.view === 'manage') return `/manage/${route.tab}`;
  if (route.sessionId) return `/chat/${encodeURIComponent(route.sessionId)}`;
  return '/';
};

interface Props {
  connection: Connection;
  role: string | null;
  onDisconnect: () => void;
}

export function ChatShell({ connection, role, onDisconnect }: Props) {
  const initialRoute = parseRoute(window.location.pathname);
  const [view, setView] = useState<View>(initialRoute.view);
  const [manageTab, setManageTab] = useState<ManageTab>(initialRoute.view === 'manage' ? initialRoute.tab : 'basic');
  const isOwner = role === 'owner';
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const initialSessionId = initialRoute.view === 'chat' ? initialRoute.sessionId : null;
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(initialSessionId);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [status, setStatus] = useState('Connecting');
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const wsRef = useRef<AgentWsClient | null>(null);
  const currentSessionRef = useRef<string | null>(null);
  const streamingTextRef = useRef('');
  const streamingThinkingRef = useRef('');
  const thinkingAsAssistantRef = useRef(false);
  const skipPushRef = useRef(false);
  const pendingSentTexts = useRef<string[]>([]);

  currentSessionRef.current = currentSessionId;

  // Sync URL when view/session/tab changes
  useEffect(() => {
    if (skipPushRef.current) { skipPushRef.current = false; return; }
    const route: Route = view === 'manage'
      ? { view: 'manage', tab: manageTab }
      : { view: 'chat', sessionId: currentSessionId };
    const path = routeToPath(route);
    if (window.location.pathname !== path) {
      history.pushState(null, '', path);
    }
  }, [view, currentSessionId, manageTab]);

  // Listen to back/forward navigation
  useEffect(() => {
    const onPopState = () => {
      skipPushRef.current = true;
      const route = parseRoute(window.location.pathname);
      setView(route.view);
      if (route.view === 'manage') {
        setManageTab(route.tab);
      } else if (route.sessionId && route.sessionId !== currentSessionRef.current) {
        void selectSessionById(route.sessionId);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const loadSession = useCallback(async (ws: AgentWsClient, sessionId: string) => {
    setCurrentSessionId(sessionId);
    setView('chat');
    setItems([]);
    setLoadingHistory(true);
    streamingTextRef.current = '';
    streamingThinkingRef.current = '';
    thinkingAsAssistantRef.current = false;
    await ws.openSession(sessionId);
    const history: HistoryMessage[] = await ws.getHistory(sessionId);
    const historyItems: ChatItem[] = [];
    let introspectionTools: Extract<ChatItem, { type: 'tool' }>[] | null = null;
    const flushIntrospection = (summary?: string) => {
      if (!introspectionTools) return;
      if (introspectionTools.length > 0) {
        historyItems.push({ type: 'introspection', tools: introspectionTools, summary });
      }
      introspectionTools = null;
    };
    for (const entry of history) {
      if (entry.role === 'introspection' && entry.introspectionPhase === 'start') {
        // If a previous introspection block never received an end (agent
        // crashed / aborted mid-introspection), flush it now so its tools
        // don't get clobbered by this new bucket.
        flushIntrospection();
        introspectionTools = [];
        continue;
      }
      if (entry.role === 'introspection' && entry.introspectionPhase === 'end') {
        historyItems.push({ type: 'introspection', tools: introspectionTools || [], summary: entry.introspectionSummary });
        introspectionTools = null;
        continue;
      }
      if (entry.role === 'tool') {
        // Route by the per-event marker, not the open introspection_start state.
        // An introspection_start without a matching introspection_end (e.g.
        // the agent crashed mid-introspection) would otherwise swallow every
        // subsequent regular tool_call into the dangling bucket and never
        // render them. payload.introspection === true is the source of truth.
        const isIntrospection = entry.introspection === true;
        const toolItem = (call: Extract<ChatItem, { type: 'tool' }>) => {
          if (isIntrospection && introspectionTools) introspectionTools.push(call);
          else historyItems.push(call);
        };
        const pool = isIntrospection && introspectionTools ? introspectionTools : historyItems;
        const findPending = (): Extract<ChatItem, { type: 'tool' }> | undefined => {
          if (entry.toolPhase !== 'result') return undefined;
          if (entry.toolCallId) {
            for (let i = pool.length - 1; i >= 0; i--) {
              const it = pool[i];
              if (it.type === 'tool' && it.toolCallId === entry.toolCallId) return it;
            }
            return undefined;
          }
          for (let i = pool.length - 1; i >= 0; i--) {
            const it = pool[i];
            if (it.type === 'tool' && it.tool === entry.tool && it.phase !== 'done') return it;
          }
          return undefined;
        };
        const pending = findPending();
        if (pending) {
          pending.phase = 'done';
          pending.isError = entry.toolIsError;
          pending.result = entry.content || undefined;
        } else if (entry.toolPhase === 'result') {
          toolItem({ type: 'tool', tool: entry.tool || '', toolCallId: entry.toolCallId, args: entry.toolArgs, phase: 'done', isError: entry.toolIsError, result: entry.content || undefined });
        } else {
          toolItem({ type: 'tool', tool: entry.tool || '', toolCallId: entry.toolCallId, args: entry.toolArgs, phase: 'running' });
        }
        continue;
      }
      if (entry.role === 'error') { historyItems.push({ type: 'event', text: entry.content, isError: true }); continue; }
      if (entry.role === 'assistant' && entry.thinking) {
        historyItems.push({ type: 'thinking', text: entry.thinking, streaming: false });
      }
      if (entry.role === 'assistant' && !entry.content) { if (entry.name) setAgentName(entry.name); continue; }
      historyItems.push({ type: entry.role as 'user' | 'assistant', text: entry.content, streaming: false, name: entry.name });
      if (entry.role === 'assistant' && entry.name) setAgentName(entry.name);
    }
    flushIntrospection();
    setItems(historyItems);
    setLoadingHistory(false);
    const allSessions = await ws.listSessions();
    const sess = allSessions.find(s => s.sessionId === sessionId);
    await ws.subscribe(sessionId, sess?.lastEventId ?? 0);
  }, []);

  const selectSessionById = useCallback(async (sessionId: string) => {
    const ws = wsRef.current;
    if (!ws) return;
    // Even if it's the same session that's already loaded, surface the
    // chat view — the user may have been on /manage and clicking the
    // session in the sidebar should bring them back to that conversation.
    if (sessionId === currentSessionRef.current) {
      setView('chat');
      return;
    }
    if (currentSessionRef.current) {
      await ws.unsubscribe(currentSessionRef.current);
    }
    await loadSession(ws, sessionId);
  }, [loadSession]);

  const handleEvent = useCallback((_eventId: number, sessionId: string, event: OutboundEvent) => {
    if (sessionId !== currentSessionRef.current) return;

    const dropPlaceholder = (items: ChatItem[]) => items.filter(i => !(i.type === 'thinking' && !i.text));

    // If the last item is thinking displayed as assistant, collapse it to a thinking block.
    // Called when something else follows (tool_call, text_delta, etc.), proving it wasn't the final answer.
    const collapseThinking = (items: ChatItem[]): ChatItem[] => {
      if (!thinkingAsAssistantRef.current) return items;
      thinkingAsAssistantRef.current = false;
      const last = items[items.length - 1];
      if (last?.type === 'assistant') {
        const updated = [...items];
        updated[updated.length - 1] = { type: 'thinking', text: last.text, streaming: false };
        return updated;
      }
      return items;
    };

    switch (event.type) {
      case 'user_message': {
        const msgText = event.text as string;
        const idx = pendingSentTexts.current.indexOf(msgText);
        if (idx !== -1) {
          pendingSentTexts.current.splice(idx, 1);
          break;
        }
        setItems(prev => [...prev, { type: 'user', text: msgText, streaming: false, name: event.name as string | undefined }]);
        break;
      }

      case 'thinking_delta':
        streamingThinkingRef.current += event.text as string;
        thinkingAsAssistantRef.current = true;
        setItems(prev => {
          const clean = dropPlaceholder(prev);
          const text = streamingThinkingRef.current;
          const last = clean[clean.length - 1];
          if (last?.type === 'assistant' && last.streaming) {
            const updated = [...clean];
            updated[updated.length - 1] = { type: 'assistant', text, streaming: true };
            return updated;
          }
          return [...clean, { type: 'assistant', text, streaming: true }];
        });
        break;

      case 'thinking_final': {
        const finalText = (event.text as string) || streamingThinkingRef.current;
        streamingThinkingRef.current = '';
        setItems(prev => {
          const last = prev[prev.length - 1];
          if (last?.type === 'assistant') {
            const updated = [...prev];
            updated[updated.length - 1] = { type: 'assistant', text: finalText, streaming: false };
            return updated;
          }
          return prev;
        });
        break;
      }

      case 'tool_call':
        setItems(prev => [...collapseThinking(dropPlaceholder(prev)), {
          type: 'tool',
          tool: event.tool as string,
          toolCallId: event.toolCallId as string | undefined,
          args: event.args,
          phase: 'running',
        }]);
        break;

      case 'tool_result':
        setItems(prev => {
          const incomingId = event.toolCallId as string | undefined;
          // Match by toolCallId first (correct under parallel calls); fall back
          // to last-running same-named tool only if the call event predates the
          // toolCallId field.
          const idx = incomingId
            ? prev.findLastIndex(i => i.type === 'tool' && i.toolCallId === incomingId)
            : prev.findLastIndex(i => i.type === 'tool' && i.tool === event.tool && i.phase !== 'done');
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              phase: 'done',
              isError: event.isError as boolean,
              result: (event.text as string) || (event.details ? JSON.stringify(event.details, null, 2) : ''),
            } as ChatItem;
            return updated;
          }
          return prev;
        });
        break;

      case 'approval_requested':
        if (event.mode !== 'realtime') break;
        setItems(prev => [...collapseThinking(dropPlaceholder(prev)), {
          type: 'approval',
          toolName: event.resourceKey as string,
          toolCallId: event.toolCallId as string,
          args: event.args,
          resolved: false,
        }]);
        break;

      case 'text_delta':
        streamingTextRef.current += event.text as string;
        setItems(prev => {
          const clean = collapseThinking(dropPlaceholder(prev));
          const text = streamingTextRef.current;
          const last = clean[clean.length - 1];
          if (last?.type === 'assistant' && last.streaming) {
            const updated = [...clean];
            updated[updated.length - 1] = { type: 'assistant', text, streaming: true };
            return updated;
          }
          return [...clean, { type: 'assistant', text, streaming: true }];
        });
        break;

      case 'text_final': {
        const finalText = (event.text as string) || streamingTextRef.current;
        streamingTextRef.current = '';
        streamingThinkingRef.current = '';
        thinkingAsAssistantRef.current = false;
        setItems(prev => {
          const last = prev[prev.length - 1];
          if (last?.type === 'assistant') {
            const updated = [...prev];
            updated[updated.length - 1] = { type: 'assistant', text: finalText, streaming: false };
            return updated;
          }
          return [...prev, { type: 'assistant', text: finalText, streaming: false }];
        });
        break;
      }

      case 'error':
        setItems(prev => [...collapseThinking(dropPlaceholder(prev)), { type: 'event', text: event.message as string, isError: true }]);
        break;

      case 'agent_end':
        streamingTextRef.current = '';
        streamingThinkingRef.current = '';
        thinkingAsAssistantRef.current = false;
        setSending(false);
        setStatus('Connected');
        wsRef.current?.listSessions().then(setSessions).catch(() => {});
        break;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!wsRef.current) return;
    const list = await wsRef.current.listSessions();
    setSessions(list);
  }, []);

  const selectSession = selectSessionById;

  const createNewSession = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws) return;

    const prev = currentSessionRef.current;
    const sessionId = createSessionId();

    // Immediately switch UI to the new empty session
    if (prev) await ws.unsubscribe(prev).catch(() => {});
    setCurrentSessionId(sessionId);
    setItems([]);
    streamingTextRef.current = '';
    streamingThinkingRef.current = '';
    thinkingAsAssistantRef.current = false;

    // Open session, subscribe to events, and refresh list; checkpoint old session in background
    if (prev) ws.checkpoint(prev, 'manual').catch(() => {});
    await ws.openSession(sessionId);
    await ws.subscribe(sessionId, 0);
    ws.listSessions().then(setSessions).catch(() => {});
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const ws = wsRef.current;
    const sessionId = currentSessionRef.current;
    if (!ws || !sessionId || !text.trim()) return;

    pendingSentTexts.current.push(text);
    setItems(prev => [...prev, { type: 'user', text, streaming: false }, { type: 'thinking' }]);
    setSending(true);
    setStatus('Running');
    streamingTextRef.current = '';
    streamingThinkingRef.current = '';
    thinkingAsAssistantRef.current = false;

    try {
      await ws.sendMessage(sessionId, text);
    } catch (error) {
      setSending(false);
      setStatus('Connected');
      setItems(prev => [...prev, { type: 'event', text: error instanceof Error ? error.message : String(error), isError: true }]);
    }
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    const ws = wsRef.current;
    if (!ws) return;
    if (!confirm('Delete this session? This cannot be undone.')) return;
    try {
      await ws.deleteSession(sessionId);
      if (currentSessionRef.current === sessionId) {
        setCurrentSessionId(null);
        setItems([]);
        history.replaceState(null, '', '/');
      }
      await refreshSessions();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }, [refreshSessions]);

  const handleApproval = useCallback(async (toolCallId: string, approved: boolean) => {
    const ws = wsRef.current;
    const sessionId = currentSessionRef.current;
    if (!ws || !sessionId) return;

    try {
      await ws.approve(sessionId, toolCallId, approved);
      setItems(prev => prev.map(item =>
        item.type === 'approval' && item.toolCallId === toolCallId
          ? { ...item, resolved: true, approved }
          : item
      ));
    } catch (error) {
      setItems(prev => [...prev, { type: 'event', text: error instanceof Error ? error.message : String(error), isError: true }]);
    }
  }, []);

  // Connect WS on mount
  useEffect(() => {
    const client = new AgentWsClient(handleEvent, (s) => {
      if (s === 'connected') setStatus('Connected');
      else if (s === 'connecting') setStatus('Connecting');
      else setStatus('Disconnected');
    });
    wsRef.current = client;

    client.setOnReconnect(() => {
      client.listSessions().then(setSessions).catch(() => {});
    });
    client.startVisibilityCheck();

    client.connect()
      .then(async () => {
        const [list] = await Promise.all([
          client.listSessions(),
          fetchAgentInfo().then(info => setAgentName(info.name)).catch(() => {}),
        ]);
        setSessions(list);
        // Only auto-load when the URL itself names a valid session.
        // Refreshing /  ̄or any non-/chat/:id path keeps the user on the
        // sessions list — don't jump them into a session they didn't pick.
        if (initialSessionId && list.some((s: SessionSummary) => s.sessionId === initialSessionId)) {
          await loadSession(client, initialSessionId);
        }
      })
      .catch(() => setStatus('Disconnected'));

    return () => {
      client.close();
      wsRef.current = null;
    };
  }, [handleEvent, loadSession]);

  const currentSession = sessions.find(s => s.sessionId === currentSessionId);
  const sessionTitle = currentSession?.description || currentSession?.lastMessagePreview || currentSessionId || 'No session';
  const isWebSession = !currentSession || currentSession.source?.kind === 'api' && currentSession.source?.platform === 'web';
  const readOnly = currentSession != null && !isWebSession;

  // On mobile, only one of sidebar / detail shows at a time. "List" mode
  // is when the user is in chat view but hasn't selected a session yet;
  // any other state (a session is open, or manage panel is up) counts as
  // "detail" mode.
  const mobileMode: 'list' | 'detail' =
    view === 'chat' && !currentSessionId ? 'list' : 'detail';
  const handleMobileBack = () => {
    if (view === 'manage') {
      setView('chat');
    } else {
      setCurrentSessionId(null);
    }
  };

  return (
    <div className={`shell shell--${mobileMode}`}>
      <aside className="sidebar">
        <div className="sidebar__top">
          <a
            className="sidebar__brand"
            href="/"
            aria-label="OpenHermit home"
            onClick={(e) => {
              e.preventDefault();
              setView('chat');
              setCurrentSessionId(null);
              if (window.location.pathname !== '/') {
                history.pushState(null, '', '/');
              }
            }}
          >
            <img src="/logo.png" alt="" className="sidebar__logo" />
            <div>
              <h1 className="sidebar__brand-name">OpenHermit</h1>
              <p className="sidebar__meta">Agent: {agentName || connection.agentId}</p>
            </div>
          </a>
          <div className="sidebar__buttons">
            <button
              className="btn btn--primary"
              onClick={() => {
                if (view === 'manage') setView('chat');
                void createNewSession();
              }}
            >
              New Session
            </button>
            {isOwner && (
              <button
                className={`btn btn--ghost${view === 'manage' ? ' is-active' : ''}`}
                onClick={() => {
                  if (view === 'manage') {
                    setView('chat');
                  } else {
                    setView('manage');
                    setManageTab('basic');
                  }
                }}
              >
                Manage
              </button>
            )}
          </div>
        </div>
        <SessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelect={sessionId => void selectSession(sessionId)}
          onDelete={sessionId => void deleteSession(sessionId)}
        />
        <div className="sidebar__footer">
          <div>
            <div className="sidebar__footer-name">
              <span className="sidebar__footer-dot" />
              {getDisplayName() || 'Anonymous'}
              {getUserId() && <span className="sidebar__footer-uid"> · {getUserId()}</span>}
            </div>
            <div className="sidebar__footer-auth">Auth: device key · WS</div>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={onDisconnect}>Disconnect</button>
        </div>
      </aside>

      <main className="chat">
        {view === 'manage' ? (
          <>
            <header className="chat__header">
              <button
                className="chat__back"
                aria-label="Back to sessions"
                onClick={handleMobileBack}
              >
                ←
              </button>
              <div>
                <p className="eyebrow">Agent Management</p>
                <h2>{connection.agentId}</h2>
              </div>
            </header>
            <div className="chat__manage-area">
              <Suspense fallback={null}>
                <ManagePanel tab={manageTab} onTabChange={setManageTab} />
              </Suspense>
            </div>
          </>
        ) : (
          <>
            <header className="chat__header">
              <button
                className="chat__back"
                aria-label="Back to sessions"
                onClick={handleMobileBack}
              >
                ←
              </button>
              <div>
                <p className="eyebrow">Current Session</p>
                <h2>{sessionTitle}</h2>
              </div>
              <p className="chat__status">{status}</p>
            </header>

            <ChatMessages items={items} agentName={agentName ?? undefined} loading={loadingHistory} onApproval={handleApproval} />

            {readOnly ? (
              <div className="composer composer--readonly">
                <span>Read-only — this session was created via {currentSession.source?.platform || currentSession.source?.kind || 'another channel'}</span>
              </div>
            ) : (
              <Composer onSend={sendMessage} disabled={sending || !currentSessionId} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
