/**
 * Turn raw model-provider failures into something an end user can act on.
 *
 * Channels deliver the `error` event's `message` straight to the chat (e.g.
 * the WeChat bridge sends `Error: ${message}`), so publishing the provider's
 * raw text meant users saw things like
 * `403 Key limit exceeded (total limit). Manage it using https://openrouter.ai/...`
 * — an English wall of internals, regardless of the user's language. The raw
 * error still belongs in logs, metrics, and the persisted session event; this
 * module only shapes what the *user* sees.
 */

export type ModelErrorKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'context_too_long'
  | 'unavailable'
  | 'generic';

/** Order matters: more specific patterns run first (e.g. "403 Key limit
 *  exceeded" must classify as quota, not auth). */
const CLASSIFIERS: Array<{ kind: ModelErrorKind; pattern: RegExp }> = [
  { kind: 'context_too_long', pattern: /context (length|window)|maximum (context|prompt)|prompt is too long|too many tokens/i },
  { kind: 'quota', pattern: /key limit exceeded|insufficient[\s\w]{0,20}credit|out of credit|quota exceeded|spend(ing)? limit|payment required|\b402\b/i },
  { kind: 'rate_limit', pattern: /\b429\b|rate.?limit|too many requests/i },
  { kind: 'auth', pattern: /invalid.{0,10}(api.?key|token)|unauthorized|authentication|\b401\b|no auth credentials/i },
  { kind: 'unavailable', pattern: /\b5\d\d\b|overloaded|service unavailable|timed?.?out|econn|network error|internal (server )?error|bad gateway|no endpoints found|\b404\b/i },
];

export const classifyModelError = (raw: string): ModelErrorKind => {
  for (const { kind, pattern } of CLASSIFIERS) {
    if (pattern.test(raw)) return kind;
  }
  return 'generic';
};

/** Languages we can phrase the notice in. Extend the table below to add one. */
export type UserLanguage = 'zh' | 'en';

/**
 * Any Han character marks the message as Chinese. Deliberately not a
 * majority vote: platform-side prompt injection appends English boilerplate
 * to user messages, so a Chinese user's text is routinely diluted with more
 * English characters than Chinese ones.
 */
export const detectUserLanguage = (text: string | undefined): UserLanguage =>
  text && /[一-鿿㐀-䶿]/.test(text) ? 'zh' : 'en';

const MESSAGES: Record<UserLanguage, Record<ModelErrorKind, string>> = {
  zh: {
    quota: '我的模型额度已经用完，暂时没法回复。请联系我的管理者充值或调整模型配置。',
    rate_limit: '当前请求有点多，我需要缓一缓，请稍后再试。',
    auth: '我的模型访问凭证失效了，请联系我的管理者检查配置。',
    context_too_long: '这段对话内容太长，我处理不过来了。可以开个新会话，或者把内容拆短一点再发我。',
    unavailable: '模型服务暂时不可用，请稍等几分钟再试。',
    generic: '我这边出了点技术问题，暂时没法回复。请稍后再试；如果一直这样，请联系我的管理者。',
  },
  en: {
    quota: "I've run out of model credits and can't reply right now. Please ask my administrator to top up or adjust the model settings.",
    rate_limit: "I'm getting too many requests at once — give me a moment and try again.",
    auth: 'My model access credentials stopped working. Please ask my administrator to check the configuration.',
    context_too_long: 'This conversation is too long for me to process. Try starting a new session or sending a shorter message.',
    unavailable: 'The model service is temporarily unavailable. Please try again in a few minutes.',
    generic: "I hit a technical problem and can't reply right now. Please try again later; if it keeps happening, contact my administrator.",
  },
};

/**
 * Build the user-facing text for a failed model turn, phrased in the language
 * of the message that triggered the turn.
 */
export const buildUserFacingModelError = (
  rawError: string,
  triggeringUserText: string | undefined,
): string => MESSAGES[detectUserLanguage(triggeringUserText)][classifyModelError(rawError)];
