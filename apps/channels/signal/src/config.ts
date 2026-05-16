export interface SignalAdapterConfig {
  httpUrl: string;
  account: string;
  agentBaseUrl: string;
  agentToken: string;
  allowedSenders?: string[];
  allowedGroupIds?: string[];
}

const E164 = /^\+[1-9]\d{6,14}$/;

const parseHttpUrl = (raw: string, fieldName: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${fieldName} must be a valid URL (got "${raw}").`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${fieldName} must be an http(s) URL (got "${parsed.protocol}").`);
  }
  return parsed.toString().replace(/\/+$/, '');
};

export const loadConfig = async (): Promise<SignalAdapterConfig> => {
  const rawHttpUrl = process.env.SIGNAL_HTTP_URL?.trim();
  const account = process.env.SIGNAL_ACCOUNT?.trim();

  if (!rawHttpUrl) {
    throw new Error('SIGNAL_HTTP_URL environment variable is required (e.g. http://signal:8080).');
  }
  if (!account) {
    throw new Error('SIGNAL_ACCOUNT environment variable is required (E.164 phone number, e.g. +15551234567).');
  }
  if (!E164.test(account)) {
    throw new Error('SIGNAL_ACCOUNT must be a valid E.164 phone number (e.g. +15551234567).');
  }

  const httpUrl = parseHttpUrl(rawHttpUrl, 'SIGNAL_HTTP_URL');

  const rawAgentBaseUrl = process.env.OPENHERMIT_AGENT_URL?.trim();
  const agentToken = process.env.OPENHERMIT_AGENT_TOKEN;

  if (!rawAgentBaseUrl) {
    throw new Error('OPENHERMIT_AGENT_URL environment variable is required.');
  }
  if (!agentToken) {
    throw new Error('OPENHERMIT_AGENT_TOKEN environment variable is required.');
  }

  const agentBaseUrl = parseHttpUrl(rawAgentBaseUrl, 'OPENHERMIT_AGENT_URL');

  const cfg: SignalAdapterConfig = { httpUrl, account, agentBaseUrl, agentToken };

  const allowedSenders = process.env.SIGNAL_ALLOWED_SENDERS;
  if (allowedSenders) cfg.allowedSenders = allowedSenders.split(',').map((s) => s.trim()).filter(Boolean);

  const allowedGroupIds = process.env.SIGNAL_ALLOWED_GROUP_IDS;
  if (allowedGroupIds) cfg.allowedGroupIds = allowedGroupIds.split(',').map((s) => s.trim()).filter(Boolean);

  return cfg;
};
