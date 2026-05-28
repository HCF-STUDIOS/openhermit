import { LOCALES, useTranslation } from '../i18n';

interface Props {
  className?: string;
}

export function LanguageSwitcher({ className }: Props) {
  const { locale, setLocale, t } = useTranslation();
  return (
    <select
      className={className ?? 'lang-switch'}
      value={locale}
      onChange={(e) => {
        const next = LOCALES.find((l) => l.code === e.target.value)?.code;
        if (next) setLocale(next);
      }}
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
