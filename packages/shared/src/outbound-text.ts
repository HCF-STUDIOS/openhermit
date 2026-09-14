/**
 * Normalise agent text before it goes out over a plain-text delivery surface.
 *
 * MiniMax models served without the OpenRouter reasoning-format compat stream
 * their output with a newline between nearly every token — and can even leak
 * chain-of-thought as body text. Delivered verbatim, a plain-text channel
 * (WeChat, or the external/amiko HTTP outbound) shows it one word per line
 * ("一行一行"). This reflows that pathological word-per-line pattern back into
 * normal text and strips any reasoning-tag wrappers, while leaving genuinely
 * paragraph-/list-formatted replies untouched.
 *
 * Scope: this is a delivery-side readability mitigation. It does NOT attempt to
 * separate reasoning into a thinking block at the model layer (that is the
 * provider-level "model-tested" fix); it only makes already-corrupted text
 * legible on the wire.
 */

const REASONING_STRAY_TAG_RE = /<\/?(?:think|thinking|reasoning)>/gi;

/** Remove balanced reasoning blocks, then any stray/unclosed wrapper tags. */
function stripReasoningTags(text: string): string {
  const withoutBlocks = text.replace(
    /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi,
    '',
  );
  return withoutBlocks.replace(REASONING_STRAY_TAG_RE, '');
}

// A line that carries intentional structure (list item, heading, quote, table,
// code fence) is never treated as a stray word fragment.
const STRUCTURAL_RE = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s|```|\|)/;
// Sentence/clause terminators (CJK + ASCII). A fragment ending in one of these
// reads as a real, deliberate line — not corruption.
const TERMINAL_RE = /[。．.!?！？…:：;；,，、]$/u;

function isShortFragment(s: string): boolean {
  return !STRUCTURAL_RE.test(s) && s.length <= 12 && !TERMINAL_RE.test(s);
}

/**
 * When the text is dominated by many ultra-short newline-separated fragments
 * (the MiniMax word-per-line corruption), rejoin them: a space between two
 * ASCII word characters (Latin needs the spacing), nothing across a CJK
 * boundary. Requires a high fragment count so short poems / quatrains and
 * normal formatted replies are left alone.
 */
function reflowWordPerLine(text: string): string {
  const parts = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 8) return text;
  const shortCount = parts.filter(isShortFragment).length;
  if (shortCount / parts.length <= 0.5) return text;

  let out = '';
  for (const part of parts) {
    if (!out) {
      out = part;
      continue;
    }
    const prev = out[out.length - 1] ?? '';
    const next = part[0] ?? '';
    const needsSpace = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
    out += (needsSpace ? ' ' : '') + part;
  }
  return out;
}

/** Full outbound cleanup: strip reasoning wrappers, reflow, tidy blank runs. */
export function sanitizeOutboundText(input: string): string {
  const stripped = stripReasoningTags(input);
  const reflowed = reflowWordPerLine(stripped);
  return reflowed.replace(/\n{3,}/g, '\n\n').trim();
}
