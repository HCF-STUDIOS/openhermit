import { useTranslation } from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

/**
 * Rendered in place of the main app when the page is not loaded over a
 * secure context (HTTPS or localhost). Web Crypto is unavailable here, so
 * device-key auth would crash with "Cannot read properties of undefined
 * (reading 'generateKey')". We surface that as a clear message instead.
 */
export function InsecureContextNotice() {
  const { t } = useTranslation();
  const url = typeof window !== 'undefined' ? window.location.href : '';
  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <h1 style={styles.h1}>{t('insecure.title')}</h1>
          <LanguageSwitcher />
        </div>
        <p style={styles.p}>{t('insecure.body1')}</p>
        <p style={styles.p}>{t('insecure.currentlyOn')}</p>
        <pre style={styles.code}>{url}</pre>
        <p style={styles.p}>{t('insecure.howToFix')}</p>
        <ul style={styles.list}>
          <li>{t('insecure.tailscale')}</li>
          <li>{t('insecure.caddy')}</li>
          <li>{t('insecure.cloudflared')}</li>
          <li>{t('insecure.localhost')}</li>
        </ul>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
    background: '#fafafa',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#222',
  },
  card: {
    maxWidth: 620,
    background: '#fff',
    border: '1px solid #e5e5e5',
    borderRadius: 8,
    padding: '2rem 2.25rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: '1rem',
  },
  h1: { margin: 0, fontSize: 22, fontWeight: 600 },
  p: { margin: '0.6rem 0', lineHeight: 1.55 },
  code: {
    background: '#f4f4f5',
    border: '1px solid #e5e5e5',
    borderRadius: 4,
    padding: '0.6rem 0.8rem',
    fontSize: 13,
    overflowX: 'auto',
    margin: '0.4rem 0 0.8rem',
  },
  list: { margin: '0.6rem 0 0', paddingLeft: '1.4rem', lineHeight: 1.6 },
};
