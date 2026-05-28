export const WHATSAPP_MAX_LENGTH = 4000;

export function markdownToWhatsApp(md: string): string {
  return md
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/__(.*?)__/g, '*$1*')
    .replace(/~~(.*?)~~/g, '~$1~')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '- ');
}

export function splitMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= WHATSAPP_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n\n', WHATSAPP_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf('\n', WHATSAPP_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', WHATSAPP_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = WHATSAPP_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
}

export function formatAgentResponse(text: string): string[] {
  return splitMessage(markdownToWhatsApp(text));
}
