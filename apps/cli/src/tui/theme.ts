import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const e = '\x1b[';

export const reset = (s: string) => `${e}0m${s}${e}0m`;
export const bold = (s: string) => `${e}1m${s}${e}0m`;
export const dim = (s: string) => `${e}2m${s}${e}0m`;
export const italic = (s: string) => `${e}3m${s}${e}0m`;
export const underline = (s: string) => `${e}4m${s}${e}0m`;
export const strikethrough = (s: string) => `${e}9m${s}${e}0m`;

export const black = (s: string) => `${e}30m${s}${e}0m`;
export const red = (s: string) => `${e}31m${s}${e}0m`;
export const green = (s: string) => `${e}32m${s}${e}0m`;
export const yellow = (s: string) => `${e}33m${s}${e}0m`;
export const blue = (s: string) => `${e}34m${s}${e}0m`;
export const magenta = (s: string) => `${e}35m${s}${e}0m`;
export const cyan = (s: string) => `${e}36m${s}${e}0m`;
export const white = (s: string) => `${e}37m${s}${e}0m`;
export const gray = (s: string) => `${e}90m${s}${e}0m`;

// ─── Shared select list theme ─────────────────────────────────────────────────

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => bold(cyan(s)),
  selectedText: (s) => bold(s),
  description: (s) => gray(s),
  scrollInfo: (s) => gray(s),
  noMatch: (s) => gray(s),
};

// ─── Editor theme ─────────────────────────────────────────────────────────────

export const editorTheme: EditorTheme = {
  borderColor: gray,
  selectList: selectListTheme,
};

// ─── Markdown theme ───────────────────────────────────────────────────────────

export const markdownTheme: MarkdownTheme = {
  heading: (s) => bold(cyan(s)),
  link: (s) => blue(s),
  linkUrl: (s) => gray(s),
  code: (s) => `${e}36m${s}${e}0m`,
  codeBlock: (s) => s,
  codeBlockBorder: gray,
  quote: (s) => gray(s),
  quoteBorder: gray,
  hr: gray,
  listBullet: cyan,
  bold,
  italic,
  strikethrough,
  underline,
};
