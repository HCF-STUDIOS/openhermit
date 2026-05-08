# @openhermit/sdk

TypeScript SDK for the [OpenHermit](https://github.com/HCF-S/openhermit) gateway and agent APIs.

## Install

```bash
npm install @openhermit/sdk
```

Requires Node 20+ (or any modern runtime with `fetch` and `WebSocket`).

## Usage

### Talking to the gateway

```ts
import { GatewayClient } from '@openhermit/sdk';

const client = new GatewayClient({
  baseUrl: 'https://gateway.example.com',
  token: '<user-jwt>',
});

const agents = await client.listAgents();
const agent = await client.createAgent({ /* ... */ });
await client.setAgentSecret(agent.agentId, 'OPENAI_API_KEY', 'sk-...', { passThrough: true });
```

### Issuing user tokens for an external platform

If you authenticate users in your own platform and want to hand them an
OpenHermit JWT without going through device-key:

```ts
import { GatewayClient } from '@openhermit/sdk';

const { token } = await GatewayClient.issueUserToken({
  baseUrl: 'https://gateway.example.com',
  adminToken: process.env.OPENHERMIT_ADMIN_TOKEN!, // server-side only
  channel: 'my-platform',                          // your stable namespace
  channelUserId: user.id,                          // your platform's user id
  displayName: user.name,
});

// Pass `token` to the user; same `(channel, channelUserId)` always
// resolves to the same gateway user.
```

### Talking to a specific agent

```ts
const agent = client.agent('agt-...');
const { sessionId } = await agent.openSession({ /* ... */ });

for await (const event of agent.postMessageStream(sessionId, { text: 'hi' })) {
  console.log(event);
}
```

### WebSocket

```ts
import { AgentWsClient } from '@openhermit/sdk';

const ws = new AgentWsClient({
  url: client.agent('agt-...').buildWsUrl(),
  token: '<user-jwt>',
});
await ws.connect();
ws.on('event', (e) => console.log(e));
await ws.sessionOpen({ sessionId, source: { kind: 'web', interactive: true } });
```

## License

MIT
