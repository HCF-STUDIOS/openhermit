import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AgentWsClient, apiFetch, fetchAgentInfo, getDisplayName, getUserId, type Connection, type SessionSummary, type HistoryMessage, type OutboundEvent } from '../api';
import { SessionList } from './SessionList';
import { ChatMessages, type ChatItem } from './ChatMessages';
import { Composer } from './Composer';
// ManagePanel only needed when user opens /manage — keep it out of the
// hot chat path.
const ManagePanel = lazy(() => import('./ManagePanel').then((m) => ({ default: m.ManagePanel })));

type View = 'chat' | 'manage' | 'observe';
type ManageTab = 'basic' | 'secrets' | 'skills' | 'mcp' | 'schedules' | 'channels' | 'policies';

const createSessionId = () =>
  `web:${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

const MANAGE_TABS: ManageTab[] = ['basic', 'secrets', 'channels', 'skills', 'mcp', 'schedules', 'policies'];

type Route =
  | { view: 'chat'; sessionId: string | null }
  | { view: 'manage'; tab: ManageTab }
  | { view: 'observe'; sessionId: string | null };

const parseRoute = (pathname: string): Route => {
  if (pathname.startsWith('/manage')) {
    const tab = pathname.split('/')[2] as ManageTab | undefined;
    return { view: 'manage', tab: MANAGE_TABS.includes(tab!) ? tab! : 'basic' };
  }
  if (pathname.startsWith('/observe')) {
    // /observe          -> sessionId null
    // /observe/<id>     -> sessionId
    const rest = pathname.slice('/observe'.length);
    if (rest === '' || rest === '/') return { view: 'observe', sessionId: null };
    const sessionId = decodeURIComponent(rest.replace(/^\//, ''));
    return { view: 'observe', sessionId: sessionId || null };
  }
  if (pathname.startsWith('/chat/')) {
    const sessionId = decodeURIComponent(pathname.slice(6));
    return sessionId ? { view: 'chat', sessionId } : { view: 'chat', sessionId: null };
  }
  return { view: 'chat', sessionId: null };
};

const routeToPath = (route: Route): string => {
  if (route.view === 'manage') return `/manage/${route.tab}`;
  if (route.view === 'observe') {
    return route.sessionId ? `/observe/${encodeURIComponent(route.sessionId)}` : '/observe';
  }
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
  // Observed sessions = other users' sessions on this agent. Only fetched
  // for owners and only when the observe view is active; kept separate
  // from `sessions` so toggling the view doesn't blow away the owner's
  // own session list.
  const [observeSessions, setObserveSessions] = useState<SessionSummary[]>([]);
  const initialSessionId = initialRoute.view === 'chat' || initialRoute.view === 'observe'
    ? initialRoute.sessionId
    : null;
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(initialSessionId);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [status, setStatus] = useState('Connecting');
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const wsRef = useRef<AgentWsClient | null>(null);
  const currentSessionRef = useRef<string | null>(null);
  const viewRef = useRef<View>(initialRoute.view);
  const streamingTextRef = useRef('');
  const streamingThinkingRef = useRef('');
  const thinkingAsAssistantRef = useRef(false);
  const skipPushRef = useRef(false);
  const pendingSentTexts = useRef<string[]>([]);

  // Inbox badge: track open approval requests + last-seen timestamp.
  // pendingRef maps requestId → ts the inbox row was created. seenAtRef is
  // the last time the user opened the inbox; anything with ts > seenAt is
  // unread. Persisted in localStorage so the badge survives reloads.
  const inboxSeenKey = `inbox-seen-at:${connection.agentId}`;
  const [inboxUnread, setInboxUnread] = useState(0);
  const inboxPendingRef = useRef<Map<string, string>>(new Map());
  const inboxSeenAtRef = useRef<string>(localStorage.getItem(inboxSeenKey) ?? '');
  const recomputeInboxBadge = useCallback(() => {
    const seenAt = inboxSeenAtRef.current;
    let count = 0;
    for (const ts of inboxPendingRef.current.values()) {
      if (!seenAt || ts > seenAt) count += 1;
    }
    setInboxUnread(count);
  }, []);
  const markInboxSeen = useCallback(() => {
    inboxSeenAtRef.current = new Date().toISOString();
    localStorage.setItem(inboxSeenKey, inboxSeenAtRef.current);
    setInboxUnread(0);
  }, [inboxSeenKey]);

  currentSessionRef.current = currentSessionId;
  viewRef.current = view;

  // Sync URL when view/session/tab changes
  useEffect(() => {
    if (skipPushRef.current) { skipPushRef.current = false; return; }
    const route: Route = view === 'manage'
      ? { view: 'manage', tab: manageTab }
      : view === 'observe'
        ? { view: 'observe', sessionId: currentSessionId }
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
      // Update the ref *before* dispatching selectSessionById so
      // loadSession reads the new view (observe vs chat) in the same
      // tick — otherwise back/forward into /observe/:id snaps back to
      // /chat/:id because loadSession sees the stale viewRef.
      viewRef.current = route.view;
      setView(route.view);
      if (route.view === 'manage') {
        setManageTab(route.tab);
      } else if (route.sessionId && route.sessionId !== currentSessionRef.current) {
        void selectSessionById(route.sessionId);
      } else if (!route.sessionId) {
        setCurrentSessionId(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const loadSession = useCallback(async (ws: AgentWsClient, sessionId: string) => {
    setCurrentSessionId(sessionId);
    // Preserve observe view so opening a session from the observation
    // list stays under /observe/:id and keeps the sidebar pointed at the
    // observed-sessions set rather than snapping back to the owner's own.
    const inObserve = viewRef.current === 'observe';
    if (!inObserve) setView('chat');
    setItems([]);
    setLoadingHistory(true);
    streamingTextRef.current = '';
    streamingThinkingRef.current = '';
    thinkingAsAssistantRef.current = false;
    // Observation mode is strictly read-only: skip session.open so we
    // don't add the owner as a participant in someone else's session.
    // History + subscribe alone are enough to render and stream.
    if (!inObserve) await ws.openSession(sessionId);
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
      // Resolution follow-up: assistant message carrying
      // metadata.resolvedRequestId. Mark the prior assistant message's
      // actions resolved instead of pushing a duplicate body — the
      // resolution status renders on the original message.
      if (entry.role === 'assistant' && entry.metadata && typeof entry.metadata.resolvedRequestId === 'string') {
        const reqId = entry.metadata.resolvedRequestId;
        const decision = entry.metadata.decision;
        for (let i = historyItems.length - 1; i >= 0; i--) {
          const it = historyItems[i];
          if (it.type === 'assistant' && it.actions?.some(a => a.type === 'approval_review' && a.requestId === reqId)) {
            historyItems[i] = { ...it, actionsResolved: true, actionsApproved: decision === 'approved' };
            break;
          }
        }
        continue;
      }
      if (entry.role === 'assistant' && entry.thinking) {
        historyItems.push({ type: 'thinking', text: entry.thinking, streaming: false });
      }
      if (entry.role === 'assistant' && !entry.content) { if (entry.name) setAgentName(entry.name); continue; }
      historyItems.push({
        type: entry.role as 'user' | 'assistant',
        text: entry.content,
        streaming: false,
        name: entry.name,
        ...(entry.role === 'assistant' && entry.actions && entry.actions.length > 0 ? { actions: entry.actions } : {}),
      });
      if (entry.role === 'assistant' && entry.name) setAgentName(entry.name);
    }
    flushIntrospection();
    setItems(historyItems);
    setLoadingHistory(false);
    const allSessions = await ws.listSessions(inObserve ? { observe: true } : undefined);
    const sess = allSessions.find(s => s.sessionId === sessionId);
    await ws.subscribe(sessionId, sess?.lastEventId ?? 0);
    if (sessionId === 'inbox') markInboxSeen();
  }, [markInboxSeen]);

  const selectSessionById = useCallback(async (sessionId: string) => {
    const ws = wsRef.current;
    if (!ws) return;
    // Even if it's the same session that's already loaded, surface the
    // chat view — the user may have been on /manage and clicking the
    // session in the sidebar should bring them back to that conversation.
    if (sessionId === currentSessionRef.current) {
      if (viewRef.current !== 'observe') setView('chat');
      return;
    }
    if (currentSessionRef.current) {
      await ws.unsubscribe(currentSessionRef.current);
    }
    await loadSession(ws, sessionId);
  }, [loadSession]);

  const handleEvent = useCallback((_eventId: number, sessionId: string, event: OutboundEvent) => {
    // Inbox runs a side-channel subscription independent of the visible
    // session so we can keep the sidebar badge live. Update tracking state
    // here before deciding whether the chat view also wants the event.
    if (sessionId === 'inbox') {
      const reqId = typeof event.requestId === 'string' ? event.requestId : undefined;
      if (event.type === 'approval_pending' && reqId) {
        if (!inboxPendingRef.current.has(reqId)) {
          inboxPendingRef.current.set(reqId, new Date().toISOString());
        }
        if (currentSessionRef.current === 'inbox') markInboxSeen();
        else recomputeInboxBadge();
      } else if (event.type === 'approval_resolved' && reqId) {
        inboxPendingRef.current.delete(reqId);
        recomputeInboxBadge();
      }
    }
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

      case 'approval_pending': {
        const requestId = (event.requestId as string) || '';
        const shortId = typeof event.shortId === 'number' ? event.shortId : Number(event.shortId);
        const requesterId = (event.requesterId as string) || 'unknown';
        const resourceType = (event.resourceType as string) || 'tool';
        const resourceKey = (event.resourceKey as string) || '';
        const text = `🔔 Approval required\n\n`
          + `User \`${requesterId}\` needs approval for ${resourceType}/${resourceKey}.\n`
          + `Request ID: ${requestId}`;
        setItems(prev => {
          // Replay safety: subscribe(lastEventId=0) on inbox replays the
          // approval_pending event we already rendered from history.
          const dup = prev.some(i => i.type === 'assistant'
            && i.actions?.some(a => a.type === 'approval_review' && a.requestId === requestId));
          if (dup) return prev;
          return [...collapseThinking(dropPlaceholder(prev)), {
            type: 'assistant',
            text,
            streaming: false,
            actions: [{ type: 'approval_review', requestId, shortId }],
          }];
        });
        break;
      }

      case 'approval_resolved': {
        const reqId = event.requestId as string | undefined;
        const decision = event.decision as 'approved' | 'rejected' | undefined;
        if (!reqId) break;
        setItems(prev => prev.map(item => {
          if (item.type === 'assistant' && item.actions?.some(a => a.type === 'approval_review' && a.requestId === reqId)) {
            return { ...item, actionsResolved: true, actionsApproved: decision === 'approved' };
          }
          if (item.type === 'approval' && item.toolCallId === reqId) {
            return { ...item, resolved: true, approved: decision === 'approved' };
          }
          return item;
        }));
        break;
      }

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
        if (viewRef.current === 'observe') {
          wsRef.current?.listSessions({ observe: true }).then(setObserveSessions).catch(() => {});
        }
        break;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!wsRef.current) return;
    const list = await wsRef.current.listSessions();
    setSessions(list);
  }, []);

  const refreshObserveSessions = useCallback(async () => {
    if (!wsRef.current || !isOwner) return;
    try {
      const list = await wsRef.current.listSessions({ observe: true });
      setObserveSessions(list);
    } catch {
      // Non-owners get [] from the gateway; ignore transient errors.
    }
  }, [isOwner]);

  const enterObserveMode = useCallback(async () => {
    if (!isOwner) return;
    setView('observe');
    setCurrentSessionId(null);
    setItems([]);
    await refreshObserveSessions();
  }, [isOwner, refreshObserveSessions]);

  // Keep observed list fresh while the view is open so newly arriving
  // channel sessions show up without a manual refresh.
  useEffect(() => {
    if (view !== 'observe') return;
    void refreshObserveSessions();
  }, [view, refreshObserveSessions]);

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

  const interruptTurn = useCallback(async () => {
    const ws = wsRef.current;
    const sessionId = currentSessionRef.current;
    if (!ws || !sessionId) return;
    try {
      await ws.interrupt(sessionId);
    } catch (error) {
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

  const handleMessageAction = useCallback(async (action: { type: string; [k: string]: unknown }, approved: boolean) => {
    if (action.type !== 'approval_review') return;
    const shortId = typeof action.shortId === 'number' ? action.shortId : Number(action.shortId);
    const requestId = typeof action.requestId === 'string' ? action.requestId : undefined;
    if (!Number.isFinite(shortId)) return;
    try {
      await apiFetch(`/approvals/by-short/${shortId}/review`, {
        method: 'POST',
        body: { decision: approved ? 'approved' : 'rejected', resolution: 'once' },
      });
      setItems(prev => prev.map(item =>
        item.type === 'assistant'
          && item.actions?.some(a => a.type === 'approval_review' && a.requestId === requestId)
          ? { ...item, actionsResolved: true, actionsApproved: approved }
          : item
      ));
    } catch (error) {
      setItems(prev => [...prev, { type: 'event', text: error instanceof Error ? error.message : String(error), isError: true }]);
    }
  }, []);

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
        // Owner-side inbox side-channel: prime pending set from history,
        // then subscribe so live approval_pending events update the badge
        // even when the user is not viewing /chat/inbox.
        if (isOwner) {
          try {
            const history = await client.getHistory('inbox');
            for (const m of history) {
              const reqId = m.actions?.find(a => a.type === 'approval_review')?.requestId as string | undefined;
              if (reqId) inboxPendingRef.current.set(reqId, m.ts ?? '');
              const resolvedId = m.metadata?.resolvedRequestId as string | undefined;
              if (resolvedId) inboxPendingRef.current.delete(resolvedId);
            }
            recomputeInboxBadge();
            await client.subscribe('inbox', 0);
          } catch {
            // owner without inbox row, or transient — badge stays at 0.
          }
        }
        // Observation mode: if the page loaded under /observe[/:id], prime
        // the observed-sessions list now so the sidebar isn't empty and so
        // the deep-link auto-load below can match against it.
        let observedList: SessionSummary[] = [];
        if (initialRoute.view === 'observe' && isOwner) {
          try {
            observedList = await client.listSessions({ observe: true });
            setObserveSessions(observedList);
          } catch {
            // gateway returns [] for non-owners; transient failures fall
            // through to an empty sidebar.
          }
        }
        // Only auto-load when the URL itself names a valid session.
        // Refreshing /  ̄or any non-/chat/:id path keeps the user on the
        // sessions list — don't jump them into a session they didn't pick.
        // Inbox is intentionally hidden from listSessions, so it never
        // satisfies the .some() check — load it directly when the URL
        // names it.
        const visibleList = initialRoute.view === 'observe' ? observedList : list;
        if (initialSessionId && (initialSessionId === 'inbox' || visibleList.some((s: SessionSummary) => s.sessionId === initialSessionId))) {
          await loadSession(client, initialSessionId);
        }
      })
      .catch(() => setStatus('Disconnected'));

    return () => {
      client.close();
      wsRef.current = null;
    };
  }, [handleEvent, loadSession, isOwner, recomputeInboxBadge]);

  const isInbox = currentSessionId === 'inbox';
  const inObserveView = view === 'observe';
  // In observe view, the visible session comes from observeSessions; in
  // chat view from sessions. Look in both so a freshly-loaded observed
  // session still resolves its title/source while observeSessions is
  // being repopulated.
  const currentSession =
    sessions.find(s => s.sessionId === currentSessionId) ??
    observeSessions.find(s => s.sessionId === currentSessionId);
  const sessionTitle = isInbox
    ? 'Inbox'
    : (currentSession?.description || currentSession?.lastMessagePreview || currentSessionId || 'No session');
  const isWebSession = !currentSession || currentSession.source?.kind === 'api' && currentSession.source?.platform === 'web';
  // Observation sessions are always read-only — owners are peeking at
  // someone else's conversation, not participating.
  const readOnly = isInbox || inObserveView || (currentSession != null && !isWebSession);

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
          <div className="sidebar__brand-row">
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
            {isOwner && (
              <button
                type="button"
                className={`sidebar__icon-btn${currentSessionId === 'inbox' && view === 'chat' ? ' is-active' : ''}`}
                aria-label="Inbox"
                title="Inbox"
                onClick={() => {
                  if (view === 'manage') setView('chat');
                  void selectSessionById('inbox');
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m3 7 9 6 9-6" />
                </svg>
                {inboxUnread > 0 && (
                  <span className="sidebar__icon-badge" aria-label={`${inboxUnread} unread`}>
                    {inboxUnread > 99 ? '99+' : inboxUnread}
                  </span>
                )}
              </button>
            )}
          </div>
          <div className="sidebar__buttons">
            <button
              className="btn btn--primary"
              onClick={() => {
                if (view === 'manage' || view === 'observe') setView('chat');
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
        {isOwner && (
          <div className="sidebar__observe-row">
            {inObserveView ? (
              <button
                type="button"
                className="sidebar__observe-btn is-active"
                onClick={() => {
                  setView('chat');
                  setCurrentSessionId(null);
                  setItems([]);
                }}
                title="Back to my sessions"
              >
                <span className="sidebar__observe-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 12H5" />
                    <path d="m12 19-7-7 7-7" />
                  </svg>
                </span>
                <span className="sidebar__observe-label">Back to my sessions</span>
              </button>
            ) : (
              <button
                type="button"
                className="sidebar__observe-btn"
                onClick={() => void enterObserveMode()}
                title="View other users' sessions on this agent"
              >
                <span className="sidebar__observe-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </span>
                <span className="sidebar__observe-label">Observation Mode</span>
              </button>
            )}
          </div>
        )}
        <SessionList
          sessions={inObserveView ? observeSessions : sessions}
          currentSessionId={currentSessionId}
          onSelect={sessionId => void selectSession(sessionId)}
          onDelete={inObserveView ? undefined : (sessionId => void deleteSession(sessionId))}
          emptyMessage={inObserveView ? 'No other-user sessions on this agent yet.' : undefined}
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

            <ChatMessages
              items={items}
              agentName={agentName ?? undefined}
              loading={loadingHistory}
              emptyMessage={isInbox ? 'No notifications yet.' : undefined}
              onApproval={handleApproval}
              onMessageAction={handleMessageAction}
            />

            {readOnly ? (
              <div className="composer composer--readonly">
                <span>
                  {isInbox
                    ? 'Read-only — inbox is the owner notification feed'
                    : inObserveView
                      ? `Read-only — observing a session from ${currentSession?.source?.platform || currentSession?.source?.kind || 'another channel'}`
                      : `Read-only — this session was created via ${currentSession?.source?.platform || currentSession?.source?.kind || 'another channel'}`}
                </span>
              </div>
            ) : (
              <Composer
                onSend={sendMessage}
                disabled={!currentSessionId}
                running={sending}
                onInterrupt={interruptTurn}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
