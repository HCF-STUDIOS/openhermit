export interface SignalAdapterConfig {
  /** Base URL of the signal-cli-rest-api container, e.g. http://signal:8080. */
  httpUrl: string;
  /** E.164 phone number of the bot's Signal account, e.g. +15551234567. */
  account: string;
  /** Per-agent base URL provided by the gateway (OPENHERMIT_AGENT_URL). */
  agentBaseUrl: string;
  /** Per-agent bearer token provided by the gateway (OPENHERMIT_AGENT_TOKEN). */
  agentToken: string;
  /** Optional list of allowed sender identifiers (E.164 or uuid:<id>) for DMs. */
  allowedSenders?: string[];
  /** Optional list of allowed group ids. */
  allowedGroupIds?: string[];
}

export const loadConfig = async (): Promise<SignalAdapterConfig> => {
  const rawHttpUrl = process.env.SIGNAL_HTTP_URL;
  const account = process.env.SIGNAL_ACCOUNT;

  if (!rawHttpUrl) {
    throw new Error('SIGNAL_HTTP_URL environment variable is required (e.g. http://signal:8080).');
  }
  if (!account) {
    throw new Error('SIGNAL_ACCOUNT environment variable is required (E.164 phone number, e.g. +15551234567).');
  }

  const httpUrl = rawHttpUrl.replace(/\/+$/, '');

  const agentBaseUrl = process.env.OPENHERMIT_AGENT_URL ?? '';
  const agentToken = process.env.OPENHERMIT_AGENT_TOKEN ?? '';

  if (!agentBaseUrl || !agentToken) {
    throw new Error('Agent connection required. Set OPENHERMIT_AGENT_URL + OPENHERMIT_AGENT_TOKEN.');
  }

  const cfg: SignalAdapterConfig = { httpUrl, account, agentBaseUrl, agentToken };

  const allowedSenders = process.env.SIGNAL_ALLOWED_SENDERS;
  if (allowedSenders) cfg.allowedSenders = allowedSenders.split(',').map((s) => s.trim()).filter(Boolean);

  const allowedGroupIds = process.env.SIGNAL_ALLOWED_GROUP_IDS;
  if (allowedGroupIds) cfg.allowedGroupIds = allowedGroupIds.split(',').map((s) => s.trim()).filter(Boolean);

  return cfg;
};
