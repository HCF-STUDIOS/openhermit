import { lazy, Suspense, useEffect, useState } from 'react';
import {
  joinAgent,
  loadConnection,
  loadGatewayUrl,
  saveGatewayUrl,
  saveConnection,
  clearConnection,
  setConnection,
  setGateway,
  initJwt,
  exchangeToken,
  redeemExchangeToken,
  getDisplayName,
  listMyAgents,
  type Connection,
} from './api';
import { PickAgentScreen } from './components/PickAgentScreen';
import { SetupScreen } from './components/SetupScreen';
// ChatShell pulls in the markdown + KaTeX stack — keep it out of the
// initial bundle for users still on Setup/PickAgent.
const ChatShell = lazy(() => import('./components/ChatShell').then((m) => ({ default: m.ChatShell })));

type Screen = 'loading' | 'setup' | 'pick-agent' | 'chat';

interface PendingJoin {
  agentId: string;
  token?: string;
}

// Read `?agent_id=…` / `?agentId=…` (+ optional `?token=…`) from the current
// URL, then strip them so a refresh doesn't re-trigger the auto-join.
function readPendingJoin(): PendingJoin | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const agentId = (params.get('agent_id') ?? params.get('agentId') ?? '').trim();
  if (!agentId) return null;
  const accessToken = (params.get('token') ?? '').trim();
  params.delete('agent_id');
  params.delete('agentId');
  params.delete('token');
  const qs = params.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
  window.history.replaceState(null, '', url);
  return accessToken ? { agentId, token: accessToken } : { agentId };
}

// Read a single-use exchange JWT from the URL fragment (`#token=…`), then
// strip it. Fragments don't hit the server log or `referer`, which makes
// them the right place to carry a short-lived credential. Returning a
// non-null token means the caller should swap it for a session JWT via
// `redeemExchangeToken` before any other auth work runs.
function readPendingExchangeToken(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = (params.get('token') ?? '').trim();
  if (!token) return null;
  params.delete('token');
  const rest = params.toString();
  const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
  window.history.replaceState(null, '', url);
  return token;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [connection, setConn] = useState<Connection | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState<string>('');
  const [pendingJoin, setPendingJoin] = useState<PendingJoin | null>(() => readPendingJoin());
  const [pendingExchange] = useState<string | null>(() => readPendingExchangeToken());
  const [pendingError, setPendingError] = useState<string>('');

  // Try to satisfy a pending /connect?agent_id=… intent: prefer an existing
  // membership, otherwise call joinAgent. On success switches to chat; on
  // failure clears the intent and surfaces the error on PickAgentScreen.
  const consumePendingJoin = async (intent: PendingJoin, gateway: string): Promise<boolean> => {
    try {
      const memberships = await listMyAgents();
      const existing = memberships.find((m) => m.agentId === intent.agentId);
      if (existing) {
        const conn: Connection = { gatewayUrl: gateway, agentId: existing.agentId, role: existing.role };
        setConn(conn);
        setConnection(conn);
        saveConnection(conn);
        setPendingJoin(null);
        setScreen('chat');
        return true;
      }
      const membership = await joinAgent(intent.agentId, intent.token);
      const conn: Connection = {
        gatewayUrl: gateway,
        agentId: intent.agentId,
        role: membership.role,
        ...(intent.token ? { token: intent.token } : {}),
      };
      setConn(conn);
      setConnection(conn);
      saveConnection(conn);
      setPendingJoin(null);
      setScreen('chat');
      return true;
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  useEffect(() => {
    initJwt();

    // `/connect#token=…` deep link: the exchange JWT IS the credential, so
    // we skip the device-key flow (Setup + exchangeToken) entirely. The
    // gateway origin is assumed to match `window.location.origin` because
    // the link only makes sense when issued by the same gateway serving
    // this SPA. We deliberately do NOT touch `openhermit_device` — if the
    // user already had a separate device-key identity, keeping it around
    // is the desired behavior (two identities on one device is fine).
    if (pendingExchange) {
      const exchangeGateway = loadGatewayUrl() ?? window.location.origin;
      setGateway(exchangeGateway);
      setGatewayUrl(exchangeGateway);
      saveGatewayUrl(exchangeGateway);
      (async () => {
        try {
          await redeemExchangeToken(exchangeGateway, pendingExchange);
        } catch (err) {
          setPendingError(err instanceof Error ? err.message : String(err));
          setScreen('setup');
          return;
        }
        if (pendingJoin) {
          if (await consumePendingJoin(pendingJoin, exchangeGateway)) return;
          setScreen('pick-agent');
          return;
        }
        setScreen('pick-agent');
      })();
      return;
    }

    // Need both display name AND a remembered gateway URL to skip setup.
    const displayName = getDisplayName();
    const savedGateway = loadGatewayUrl();
    if (!displayName || !savedGateway) {
      setScreen('setup');
      return;
    }
    setGateway(savedGateway);
    setGatewayUrl(savedGateway);

    // Try to refresh the JWT silently. If the device key is still valid
    // for this gateway we go straight to agent picker / last chat.
    (async () => {
      try {
        await exchangeToken(displayName);
      } catch {
        setScreen('setup');
        return;
      }

      if (pendingJoin) {
        if (await consumePendingJoin(pendingJoin, savedGateway)) return;
        setScreen('pick-agent');
        return;
      }

      const saved = loadConnection();
      if (saved?.agentId) {
        // Refresh role from server — it may have changed since last visit.
        let role = saved.role;
        try {
          const memberships = await listMyAgents();
          const m = memberships.find((x) => x.agentId === saved.agentId);
          if (!m) {
            setScreen('pick-agent');
            return;
          }
          role = m.role;
        } catch {
          // fall through with stored role
        }
        const fresh: Connection = { ...saved, ...(role ? { role } : {}) };
        setConn(fresh);
        setConnection(fresh);
        saveConnection(fresh);
        setScreen('chat');
      } else {
        setScreen('pick-agent');
      }
    })();
  }, []);

  const handleSetupComplete = async (): Promise<void> => {
    const url = loadGatewayUrl();
    if (url) setGatewayUrl(url);
    if (pendingJoin && url) {
      if (await consumePendingJoin(pendingJoin, url)) return;
    }
    setScreen('pick-agent');
  };

  const handlePickAgent = async (conn: Connection): Promise<void> => {
    setConnection(conn);
    saveConnection(conn);
    setConn(conn);
    setScreen('chat');
  };

  const handleDisconnect = (): void => {
    clearConnection();
    setConn(null);
    setScreen('pick-agent');
  };

  const handleSignOut = (): void => {
    clearConnection();
    localStorage.removeItem('openhermit_jwt');
    localStorage.removeItem('openhermit_gateway_url');
    setConn(null);
    setScreen('setup');
  };

  if (screen === 'loading') return null;

  if (screen === 'setup') {
    return <SetupScreen onComplete={() => void handleSetupComplete()} />;
  }

  if (screen === 'pick-agent') {
    return (
      <PickAgentScreen
        gatewayUrl={gatewayUrl}
        onPick={handlePickAgent}
        onSignOut={handleSignOut}
        initialJoinAgentId={pendingJoin?.agentId}
        initialJoinToken={pendingJoin?.token}
        initialError={pendingError || undefined}
      />
    );
  }

  return (
    <Suspense fallback={null}>
      <ChatShell
        connection={connection!}
        role={connection?.role ?? null}
        onDisconnect={handleDisconnect}
      />
    </Suspense>
  );
}
