export const redactId = (value: string | undefined | null): string => {
  if (!value) return '****';
  const s = String(value);
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
};

export const redactTarget = (target: string | undefined | null): string => {
  if (!target) return '****';
  const s = String(target);
  const idx = s.lastIndexOf(':');
  if (idx === -1) return redactId(s);
  return `${s.slice(0, idx + 1)}${redactId(s.slice(idx + 1))}`;
};
