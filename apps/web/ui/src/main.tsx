import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { InsecureContextNotice } from './components/InsecureContextNotice';
import { LocaleProvider } from './i18n';
import './styles.css';

// The web UI uses Web Crypto (window.crypto.subtle) to manage device keys
// for ECDSA-based auth. That API is only exposed in secure contexts —
// HTTPS, http://localhost, or http://127.0.0.1. Accessing the UI over
// plain HTTP on a public IP returns `crypto.subtle === undefined` and the
// app crashes on first load. Show a friendlier explanation instead.
const root = createRoot(document.getElementById('root')!);
if (typeof window !== 'undefined' && !window.isSecureContext) {
  root.render(
    <StrictMode>
      <LocaleProvider>
        <InsecureContextNotice />
      </LocaleProvider>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </StrictMode>,
  );
}
