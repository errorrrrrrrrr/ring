/* ── The composer's entry (spec 13.1, 14) ─────────────────────────────────────
 * Vite builds this into app-dist/ (gitignored); the server answers /app with
 * the built index.html to a signed-in member (routes/app.js). One module
 * script, one stylesheet, both same-origin files: the CSP stays self-only.
 * P8: /admin answers the same page to an admin; its tabs are a LAZY chunk of
 * this bundle (admin.tsx), loaded only there, so /app never fetches it.
 */
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './ring.css';
import { App } from './app.tsx';

const Admin = lazy(() => import('./admin.tsx').then((m) => ({ default: m.Admin })));
const isAdmin = /^\/admin\/?$/.test(location.pathname);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>{isAdmin ? <Suspense fallback={null}><Admin /></Suspense> : <App />}</StrictMode>,
  );
}
