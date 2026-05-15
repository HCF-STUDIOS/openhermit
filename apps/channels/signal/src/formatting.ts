export const SIGNAL_MAX_LENGTH = 2000;

// Signal styled text has no native headings or list bullets; flatten to bold + •.
export function markdownToSignalStyled(md: string): string {
  return md
    .replace(/~~(.*?)~~/g, '~$1~')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '• ');
}

export function splitMessage(text: string): string[] {
  if (text.length <= SIGNAL_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SIGNAL_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n\n', SIGNAL_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf('\n', SIGNAL_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', SIGNAL_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = SIGNAL_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
}

export function formatAgentResponse(text: string): string[] {
  return splitMessage(markdownToSignalStyled(text));
}
