import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALES,
  messages,
  type Locale,
  type MessageKey,
} from './messages';

export { DEFAULT_LOCALE, LOCALES, type Locale, type MessageKey } from './messages';

const STORAGE_KEY = 'openhermit_locale';

const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && LOCALES.some((l) => l.code === value);

const loadLocale = (): Locale => {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // localStorage unavailable — fall through.
  }
  return DEFAULT_LOCALE;
};

const persistLocale = (locale: Locale): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore
  }
};

const substitute = (
  template: string,
  vars?: Record<string, string | number>,
): string => {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
};

export type Translator = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translator;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

interface LocaleProviderProps {
  children: ReactNode;
}

export function LocaleProvider({ children }: LocaleProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => loadLocale());

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', locale);
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  }, []);

  const t = useCallback<Translator>(
    (key, vars) => {
      const entry = messages[key];
      const template = entry[locale] ?? entry.en;
      return substitute(template, vars);
    },
    [locale],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useTranslation must be used inside <LocaleProvider>');
  }
  return ctx;
}
