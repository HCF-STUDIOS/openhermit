# WhatsApp Channel Adapter

`@openhermit/channel-whatsapp` connects an OpenHermit agent to WhatsApp
through WhatsApp Web using [Baileys](https://baileys.wiki/). The plugin
is **not bundled** in the CLI; operators install and load it explicitly.

## Scope

- WhatsApp Web / Linked Devices auth through a QR setup wizard.
- Text inbound and outbound for direct chats and groups.
- **Media inbound**: image / video / document attachments are downloaded and
  uploaded to the agent as attachments (images are available as vision input);
  captions ride along as text. Voice / audio notes are transcribed via the
  agent's STT, and replies to a voice note are spoken back as a voice note when
  the agent's TTS is configured.
- **Media outbound**: the agent's `attachment_send` deliveries are routed to the
  matching WhatsApp send (image / video / document / voice note).
- Optional allow-lists (`allowed_senders`, `allowed_group_jids`).
- `/new` starts a fresh OpenHermit session for the current chat.
- Media larger than the 25 MiB attachment cap is skipped.
- No reactions, read receipts, pairing approvals, multi-account routing, or
  history injection yet.

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
5. When linking completes, OpenHermit stores `auth_profile` in the
   channel row and writes the Baileys auth state to encrypted database-backed
   channel credentials.

The auth state is internal OpenHermit state. It is stored in PostgreSQL and
encrypted with `OPENHERMIT_SECRETS_KEY`; moving the gateway no longer requires
copying a local WhatsApp credential directory.

## Stored config

After successful setup, `agent_channels.config` contains:

```jsonc
{
  "auth_profile": "default",
  "allowed_senders": ["+15551234567"],          // optional
  "allowed_group_jids": ["120363000000000@g.us"] // optional; "*" allows all groups
}
```

The profile points to encrypted rows in `agent_channel_credentials`; Baileys
`creds` and signal keys are not stored in `agent_channels.config`.

Without `allowed_senders`, direct messages are accepted from anyone.
Groups are default-deny unless `allowed_group_jids` is set.

## Runtime notes

- Status and broadcast chats are ignored.
- Own messages from the linked account are ignored to avoid loops.
- Group messages are recorded only when the group is allowed; they
  trigger the agent only when the bot is mentioned.
- Outbound targets accept a raw WhatsApp JID, a `whatsapp:<jid>` value,
  or an E.164 number such as `+15551234567`.
- Legacy `auth_dir` configs are no longer used. If one is found under
  `~/.openhermit/credentials/whatsapp/`, the adapter best-effort deletes it
  and requires setup to be run again.
- Baileys is not affiliated with WhatsApp. Use a dedicated number when
  possible and avoid bulk or spam-like behavior.
