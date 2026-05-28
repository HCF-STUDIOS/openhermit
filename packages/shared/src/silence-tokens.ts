// Tokens the agent can emit to stay silent. `<NO_REPLY>` is the documented
// group-mode silence marker; `<EMPTY_RESPONSE>` is a legacy variant from
// earlier custom-instruction templates. Channel bridges accept either so
// the model's choice doesn't leak into outbound messages.
export const SILENCE_TOKENS = ['<NO_REPLY>', '<EMPTY_RESPONSE>'] as const;

export interface StripSilenceResult {
  /** Input text with every silence token removed and edges trimmed. */
  text: string;
  /** At least one silence token was present in the input. */
  hadToken: boolean;
  /**
   * The agent explicitly chose to stay silent: a silence token was present
   * AND nothing meaningful remains after stripping it. An empty/whitespace
   * input with no token is NOT considered silent here — that's a separate
   * "agent produced nothing" condition the caller should treat as it sees
   * fit (e.g., an upstream error or empty stream).
   */
  isSilent: boolean;
}

// The model occasionally emits a real reply AND the silence token in the
// same final string (e.g., "ok, sounds good.\n<NO_REPLY>"). A strict-equality
// check on the trimmed text misses that and the literal "<NO_REPLY>" leaks
// to the destination channel. Strip the token from anywhere; if the
// remainder is empty/whitespace the model meant silence, otherwise the
// remainder is the message to send.
export const stripSilenceTokens = (text: string): StripSilenceResult => {
  let stripped = text;
  let hadToken = false;
  for (const tok of SILENCE_TOKENS) {
    if (stripped.includes(tok)) {
      hadToken = true;
      stripped = stripped.split(tok).join('');
    }
  }
  const trimmed = stripped.trim();
  return {
    text: trimmed,
    hadToken,
    isSilent: hadToken && trimmed.length === 0,
  };
};
