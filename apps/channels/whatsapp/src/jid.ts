import { randomUUID } from 'node:crypto';

export const WHATSAPP_DM_DOMAIN = '@s.whatsapp.net';
export const WHATSAPP_GROUP_DOMAIN = '@g.us';

const E164 = /^\+[1-9]\d{6,14}$/;

export function normalizeJid(jid: string): string {
  const trimmed = jid.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return trimmed;
  const user = trimmed.slice(0, at).replace(/:\d+$/, '');
  return `${user}${trimmed.slice(at)}`;
}

export function isGroupJid(jid: string): boolean {
  return normalizeJid(jid).endsWith(WHATSAPP_GROUP_DOMAIN);
}

export function isBroadcastJid(jid: string): boolean {
  const normalized = normalizeJid(jid);
  return (
    normalized === 'status@broadcast' ||
    normalized.endsWith('@broadcast') ||
    normalized.endsWith('@newsletter')
  );
}

export function jidToPhone(jid: string): string | undefined {
  const normalized = normalizeJid(jid);
  if (!normalized.endsWith(WHATSAPP_DM_DOMAIN)) return undefined;
  const user = normalized.slice(0, -WHATSAPP_DM_DOMAIN.length);
  if (!/^\d{7,15}$/.test(user)) return undefined;
  return `+${user}`;
}

export function phoneToJid(phone: string): string | undefined {
  const trimmed = phone.trim();
  if (!E164.test(trimmed)) return undefined;
  return `${trimmed.slice(1)}${WHATSAPP_DM_DOMAIN}`;
}

export function targetToJid(target: string): string {
  const stripped = target.trim().replace(/^whatsapp:/i, '');
  const byPhone = phoneToJid(stripped);
  if (byPhone) return byPhone;
  if (/^\d{7,15}$/.test(stripped)) return `${stripped}${WHATSAPP_DM_DOMAIN}`;
  return normalizeJid(stripped);
}

export function conversationKey(chatJid: string): string {
  const normalized = normalizeJid(chatJid);
  if (isGroupJid(normalized)) return `whatsapp:group:${normalized}`;
  return `whatsapp:${jidToPhone(normalized) ?? normalized}`;
}

export function generateSessionId(isGroup = false): string {
  const day = new Date().toISOString().slice(0, 10);
  const suffix = randomUUID().slice(0, 8);
  return isGroup ? `whatsapp:group:${day}-${suffix}` : `whatsapp:${day}-${suffix}`;
}

export function senderAllowed(senderJid: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  const normalized = normalizeJid(senderJid);
  const phone = jidToPhone(normalized);
  return allowed.some((entry) => {
    const item = entry.trim();
    if (!item) return false;
    if (item === '*') return true;
    if (phone && item === phone) return true;
    return normalizeJid(item) === normalized;
  });
}

export function groupAllowed(groupJid: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return false;
  const normalized = normalizeJid(groupJid);
  return allowed.some((entry) => {
    const item = entry.trim();
    return item === '*' || normalizeJid(item) === normalized;
  });
}

export function cleanBotCommandText(text: string, botJid: string | undefined): string {
  let cleaned = text.trim();
  if (botJid) {
    const phone = jidToPhone(botJid);
    const digits = phone?.slice(1);
    if (digits) {
      cleaned = cleaned.replace(new RegExp(`@${digits}\\b`, 'g'), '').trim();
    }
  }
  return cleaned;
}

export function isNewCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '/new' || normalized === 'new';
}
