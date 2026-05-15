export interface SignalAdapterConfig {
  httpUrl: string;
  account: string;
  agentBaseUrl: string;
  agentToken: string;
  allowedSenders?: string[];
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

  const agentBaseUrl = process.env.OPENHERMIT_AGENT_URL;
  const agentToken = process.env.OPENHERMIT_AGENT_TOKEN;

  if (!agentBaseUrl) {
    throw new Error('OPENHERMIT_AGENT_URL environment variable is required.');
  }
  if (!agentToken) {
    throw new Error('OPENHERMIT_AGENT_TOKEN environment variable is required.');
  }

  const cfg: SignalAdapterConfig = { httpUrl, account, agentBaseUrl, agentToken };

  const allowedSenders = process.env.SIGNAL_ALLOWED_SENDERS;
  if (allowedSenders) cfg.allowedSenders = allowedSenders.split(',').map((s) => s.trim()).filter(Boolean);

  const allowedGroupIds = process.env.SIGNAL_ALLOWED_GROUP_IDS;
  if (allowedGroupIds) cfg.allowedGroupIds = allowedGroupIds.split(',').map((s) => s.trim()).filter(Boolean);

  return cfg;
};
