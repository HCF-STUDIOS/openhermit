# Signal Channel Adapter

`@openhermit/channel-signal` connects an OpenHermit agent to a Signal
account via [`bbernhard/signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api).
The plugin is **not bundled** in the CLI — operators install it
explicitly when they want Signal support.

## v1 scope

- Text inbound and outbound (no media)
- DMs and group messages
- QR-link wizard via `ChannelSetup`
- Optional allow-lists (`allowed_senders`, `allowed_group_ids`)
- `MODE=json-rpc` enforced at runtime; the wizard temporarily uses the
  daemon's `MODE=normal` mode for the QR-link step

## Loading the plugin

Add the package name to your gateway config:

```jsonc
// ~/.openhermit/gateway/config.json
{
  "channelPackages": ["@openhermit/channel-signal"]
}
```

For npm-installed CLI:

```bash
npm install -g @openhermit/channel-signal
```

For monorepo dev: workspace resolution handles it; nothing to install.

On gateway boot the plugin loader picks up the package via dynamic
import and registers the `signal` manifest as an `external` origin.
Unlike the bundled built-ins (telegram/slack/discord), no row is
auto-seeded on agent create — owners add Signal on demand from the
admin UI's "Add channel" picker.

## Linking a Signal account

1. In the admin UI, **Channels → Add channel → Signal**.
2. Enter the daemon URL (default: `http://localhost:8080`) and the bot's
   E.164 phone number.
3. The wizard renders a QR code. Open Signal on your phone → Settings
   → Linked Devices → Link New Device → scan.
4. Once the daemon registers the new linked device, the wizard auto-
   advances to `done` and the channel row is persisted.

For the QR-link to work, the daemon must run in `MODE=normal` (its
default). After the device is linked, restart the daemon with
`MODE=json-rpc` so the receive WebSocket comes online — that's what
the bridge uses for inbound messages.

## Daemon docker-compose snippets

The daemon's `MODE` env var must change between linking and steady-state
operation. Restart (or redeploy) the container after switching.

### 1. Linking mode (first-time QR link)

```yaml
signal:
  image: bbernhard/signal-cli-rest-api:latest
  environment:
    # MODE=normal exposes the QR-link endpoint used by the wizard.
    MODE: normal
  volumes:
    - signal-data:/home/.local/share/signal-cli
  ports:
    - "8080:8080"
```

### 2. Runtime mode (after linking)

```yaml
signal:
  image: bbernhard/signal-cli-rest-api:latest
  environment:
    # MODE=json-rpc enables the receive WebSocket the bridge consumes.
    MODE: json-rpc
  volumes:
    - signal-data:/home/.local/share/signal-cli
  ports:
    - "8080:8080"
```

## Stored config

After successful setup, the persisted `agent_channels.config` row is:

```jsonc
{
  "http_url": "http://localhost:8080",
  "account": "+15551234567",
  "allowed_senders": ["+15559999999", "uuid:abc-123"],   // optional
  "allowed_group_ids": ["base64GroupId=="]               // optional
}
```

Allow-lists are edited later via the channel card's PATCH form. Without
them the bot accepts DMs from anyone and ignores all groups.

## Standalone mode (development)

For local testing without going through the gateway:

```bash
SIGNAL_HTTP_URL=http://localhost:8080 \
SIGNAL_ACCOUNT=+15551234567 \
OPENHERMIT_AGENT_URL=http://localhost:4000/api/agents/main \
OPENHERMIT_AGENT_TOKEN=$AGENT_TOKEN \
npm run dev -w @openhermit/channel-signal
```

This runs the bridge as its own process and skips the manifest /
gateway-pool path entirely. Useful for debugging the receive loop in
isolation.

## Gotchas

- **No native group mentions.** Group routing relies on
  `allowed_group_ids`; the bot replies to every message in an allowed
  group.
- **No streaming edits.** Replies are sent as full chunks at
  `agent_end`. Signal's protocol doesn't support reliable own-message
  edits.
- **Self-loopback drop is theoretical.** Until the manifest's `start()`
  populates `selfUuid` from `/v1/accounts/{number}/identity`, sync
  messages are filtered solely by lacking a `dataMessage`. In linked-
  secondary-device deployments this is sufficient in practice.
- **QR-link captcha.** If the daemon was previously registered to a
  different number, signal-cli may demand a captcha for the new
  registration. The wizard surfaces the daemon's error verbatim;
  follow the [signal-cli captcha
  docs](https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha)
  to clear it.
