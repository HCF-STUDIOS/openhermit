import { LOCALES, useTranslation, type Locale } from '../i18n';

interface Props {
  className?: string;
}

export function LanguageSwitcher({ className }: Props) {
  const { locale, setLocale, t } = useTranslation();
  return (
    <select
      className={className ?? 'lang-switch'}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label={t('lang.aria')}
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
