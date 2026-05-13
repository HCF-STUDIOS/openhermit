# @openhermit/channel-signal

Signal channel adapter for OpenHermit. Connects an agent to a Signal phone
number via an external [`bbernhard/signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api)
container running in `MODE=json-rpc`.

## Operator setup

### 1. Run the daemon

```yaml
# docker-compose.yml fragment
signal:
  image: bbernhard/signal-cli-rest-api:latest
  environment:
    MODE: json-rpc        # REQUIRED — anything else breaks the receive WS
  volumes:
    - signal-data:/home/.local/share/signal-cli
  ports:
    - "8080:8080"
```

`MODE=json-rpc` is non-negotiable. The adapter probes `/v1/about` at
startup and refuses to start otherwise.

### 2. Register or link a Signal account

Pick one path, both done against the running container before configuring
OpenHermit:

**Link as a secondary device (recommended):**

```bash
curl http://localhost:8080/v1/qrcodelink?device_name=OpenHermit -o qr.png
# Open qr.png on your laptop, scan from Signal → Settings → Linked Devices.
```

**Register a dedicated bot number with SMS:**

```bash
# 1. Generate a captcha token at https://signalcaptchas.org/registration/generate.html
#    (the token expires within seconds — register from a machine with a browser nearby)
curl -X POST -H "Content-Type: application/json" \
  -d '{"captcha": "signalcaptcha://..."}' \
  http://localhost:8080/v1/register/+15551234567

# 2. After the SMS arrives:
curl -X POST -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:8080/v1/register/+15551234567/verify/123-456
```

Don't reuse a phone number that's already active on a Signal app — registering
will deauthenticate that phone.

### 3. Configure the channel in OpenHermit

In the admin UI: Agents → your agent → Channels → enable **Signal**, paste:

- **signal-cli-rest-api URL** → `http://signal:8080` (or wherever the
  daemon is reachable from the gateway)
- **Bot phone number** → the E.164 number registered/linked above

Or via the REST API:

```bash
curl -X PUT $GATEWAY/api/agents/main/channels/signal \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "config": { "http_url": "http://signal:8080", "account": "+15551234567" } }'
```

## Standalone mode

For local testing without the gateway, run the adapter as a sidecar:

```bash
SIGNAL_HTTP_URL=http://localhost:8080 \
SIGNAL_ACCOUNT=+15551234567 \
OPENHERMIT_AGENT_URL=http://localhost:4000/api/agents/main \
OPENHERMIT_AGENT_TOKEN=$AGENT_TOKEN \
npm run dev -w @openhermit/channel-signal
```

## Allow-list (optional)

To restrict who can DM the bot, or which groups it listens in:

```bash
SIGNAL_ALLOWED_SENDERS="+15551111111,uuid:abc-def-...,+15552222222"
SIGNAL_ALLOWED_GROUP_IDS="base64GroupId1==,base64GroupId2=="
```

> Heads up: because Signal has no first-class @mentions, the bot replies to **every** message in an allow-listed group, not only ones that address it. Use group allow-listing sparingly — it's a coarser filter than `@bot` in Slack/Discord.

Without these the bot accepts all incoming traffic — fine for personal-use
deployments, not fine for public bot numbers.

## Gotchas

- **No native group mentions.** Group routing relies on `allowed_group_ids`
  rather than `@bot` mentions because Signal lacks first-class mentions.
- **No message editing.** Replies are sent as complete chunks once the
  agent reaches `agent_end`. No streaming-edit UX like Slack.
- **Self-loopback drop.** If the bot is linked as a secondary device, the
  daemon will echo its own outbound messages back through `/v1/receive`.
  The adapter drops these via `sourceUuid === selfUuid`.
- **Backup `~/.local/share/signal-cli`.** If you lose the daemon's data
  volume you'll need to re-register or re-link.
