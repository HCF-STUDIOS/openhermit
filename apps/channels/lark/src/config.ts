/** Runtime config persisted in the agent's `agent_channels` row. */
export interface LarkRuntimeConfig {
  enabled?: boolean;
  /** App ID from the Lark/Feishu Developer Console (e.g. `cli_a1b2c3…`). */
  app_id: string;
  /** App Secret — normally referenced as `${{LARK_APP_SECRET}}`. */
  app_secret: string;
  /**
   * Which platform the tenant lives on. `feishu` → open.feishu.cn (China),
   * `lark` → open.larksuite.com (international). Defaults to `feishu`.
   */
  domain?: 'feishu' | 'lark';
}

export const parseLarkConfig = (input: unknown): LarkRuntimeConfig => {
  if (typeof input !== 'object' || input === null) {
    throw new Error('lark config must be an object');
  }
  const raw = input as Record<string, unknown>;
  const appId = typeof raw.app_id === 'string' ? raw.app_id.trim() : '';
  const appSecret = typeof raw.app_secret === 'string' ? raw.app_secret.trim() : '';
  if (!appId) throw new Error('lark config requires app_id');
  if (!appSecret || appSecret.startsWith('${{')) {
    throw new Error('lark config requires app_secret (set the LARK_APP_SECRET secret)');
  }
  const domain = raw.domain === 'lark' ? 'lark' : 'feishu';
  return {
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    app_id: appId,
    app_secret: appSecret,
    domain,
  };
};
