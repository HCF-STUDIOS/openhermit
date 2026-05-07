# Gateway

`apps/gateway` is OpenHermit's control plane.

Current responsibilities:

- load `~/.openhermit/gateway/.env` and `~/.openhermit/gateway/gateway.json`
- connect Drizzle-backed PostgreSQL stores when `DATABASE_URL` is set
- register built-in skills from `skills/`
- manage agent records and in-process `AgentRunner` instances (lazy hydration on first request)
- expose agent routes under `/agents/{agentId}/...`
- expose admin/owner management routes under `/api/...`
- serve the admin UI at `/admin/` when enabled
- attach the WebSocket gateway at `/agents/{agentId}/ws`
- launch configured built-in channel adapters and maintain channel status
- start/stop each runner's scheduler and MCP connections with the runner lifecycle

The gateway listens on `GATEWAY_PORT`, then `PORT`, then `4000`, bound to `127.0.0.1`.

`gateway.json` supports:

```json
{
  "ui": true,
  "cors": { "origin": "*" }
}
```

See [../../docs/architecture.md](../../docs/architecture.md) and [../../docs/transport-protocol.md](../../docs/transport-protocol.md).
