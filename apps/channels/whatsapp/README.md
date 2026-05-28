# WhatsApp Channel Adapter

`@openhermit/channel-whatsapp` connects an OpenHermit agent to WhatsApp
through WhatsApp Web using [Baileys](https://baileys.wiki/). The plugin
is **not bundled** in the CLI; operators install and load it explicitly.

## v1 scope

- WhatsApp Web / Linked Devices auth through a QR setup wizard.
- Text inbound and outbound for direct chats and groups.
- Captions on image / video / document messages are treated as text.
- Optional allow-lists (`allowed_senders`, `allowed_group_jids`).
- `/new` starts a fresh OpenHermit session for the current chat.
- No media delivery, reactions, read receipts, pairing approvals,
  multi-account routing, or history injection yet.

## Loading the plugin

Add the package name to your gateway config:

```jsonc
{
  "channelPackages": ["@openhermit/channel-whatsapp"]
}
```

For npm-installed CLI:

```bash
npm install -g @openhermit/channel-whatsapp
```

For monorepo development, workspace resolution handles it.

On gateway boot the plugin loader registers the `whatsapp` manifest as
an external package channel. Owners link it from the Channels panel using
the generic setup wizard.

## Linking WhatsApp

1. In the admin UI, open **Channels** and choose **WhatsApp**.
2. Click **Set up**.
3. Open WhatsApp on your phone, then **Linked devices**.
4. Scan the QR code shown by OpenHermit.
5. When linking completes, OpenHermit stores the auth directory in the
   channel row and enables the channel.

The auth state is stored on the gateway host. Moving the gateway to a
new machine requires moving the configured `auth_dir` too.

## Stored config

After successful setup, `agent_channels.config` contains:

```jsonc
{
  "auth_dir": "~/.openhermit/credentials/whatsapp/main/default",
  "allowed_senders": ["+15551234567"],          // optional
  "allowed_group_jids": ["120363000000000@g.us"] // optional; "*" allows all groups
}
```

Without `allowed_senders`, direct messages are accepted from anyone.
Groups are default-deny unless `allowed_group_jids` is set.

## Runtime notes

- Status and broadcast chats are ignored.
- Own messages from the linked account are ignored to avoid loops.
- Group messages are recorded only when the group is allowed; they
  trigger the agent only when the bot is mentioned.
- Outbound targets accept a raw WhatsApp JID, a `whatsapp:<jid>` value,
  or an E.164 number such as `+15551234567`.
- Baileys is not affiliated with WhatsApp. Use a dedicated number when
  possible and avoid bulk or spam-like behavior.
