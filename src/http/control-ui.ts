import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppDeps } from './server.js';

const CSS = readFileSync(new URL('../../public/assets/control-center.css', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../../public/assets/control-center.js', import.meta.url), 'utf8');
const COMPONENTS_JS = readFileSync(new URL('../../public/assets/components.js', import.meta.url), 'utf8');
const NAMESPACE_JS = readFileSync(new URL('../../public/assets/namespace-selector.mjs', import.meta.url), 'utf8');

const HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#12243c">
  <title>ContextHub Control Center</title>
  <link rel="stylesheet" href="/assets/control-center.css">
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar" id="sidebar" aria-label="主要導覽">
      <a class="brand" href="/dashboard" aria-label="ContextHub 總覽">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span><strong>ContextHub</strong><small>Control Center</small></span>
      </a>
      <nav id="primary-nav" class="primary-nav"></nav>
      <div class="trust-note">
        <span class="status-dot good" aria-hidden="true"></span>
        <span><strong>Private control plane</strong><small>Tailscale identity · no browser keys</small></span>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-start">
          <button class="icon-button mobile-menu" id="menu-toggle" type="button" aria-label="開啟導覽" aria-controls="sidebar" aria-expanded="false">☰</button>
          <div class="breadcrumb"><span>Control Center</span><b id="current-section">總覽</b></div>
        </div>
        <div class="topbar-actions">
          <label class="namespace-control" for="namespace-selector">
            <span>目前空間</span>
            <select id="namespace-selector" aria-label="選擇命名空間"></select>
          </label>
          <button class="identity-button" id="identity-button" type="button" aria-label="目前登入身分">
            <span class="avatar" aria-hidden="true">…</span>
            <span class="identity-copy"><strong>正在驗證</strong><small>請稍候</small></span>
          </button>
        </div>
      </header>

      <main class="content-shell">
        <div id="status" class="toast" role="status" aria-live="polite"></div>
        <section id="content" class="page" aria-live="polite" aria-busy="true"></section>
      </main>
    </div>
  </div>

  <dialog id="detail-dialog" class="sheet-dialog" aria-labelledby="detail-dialog-title">
    <div class="dialog-toolbar">
      <div><span class="section-kicker">DETAIL</span><h2 id="detail-dialog-title">詳細資料</h2></div>
      <button class="icon-button" type="button" data-dialog-close aria-label="關閉">×</button>
    </div>
    <div id="detail-dialog-content" class="dialog-content"></div>
  </dialog>

  <dialog id="enrollment-secret-modal" class="modal" aria-labelledby="enrollment-secret-title">
    <button class="icon-button modal-close" type="button" data-enrollment-close aria-label="關閉">×</button>
    <span class="secret-icon" aria-hidden="true">1×</span>
    <h2 id="enrollment-secret-title">Enrollment code 只顯示一次</h2>
    <p class="muted">請立即交給受信任的 Agent helper。關閉後，ContextHub 不會再次顯示這組 code。</p>
    <code class="secret-code" data-enrollment-code></code>
    <p class="countdown" data-enrollment-countdown></p>
    <div class="dialog-actions">
      <button class="button secondary" type="button" data-enrollment-copy>複製 code</button>
      <button class="button primary" type="button" data-enrollment-close>我已安全保存</button>
    </div>
  </dialog>

  <div class="sidebar-scrim" id="sidebar-scrim" hidden></div>
  <script type="module" src="/assets/control-center.js"></script>
</body>
</html>`;

const UI_PATHS = [
  '/',
  '/dashboard',
  '/memories',
  '/review',
  '/agents',
  '/namespaces',
  '/policies',
  '/audit',
  '/effectiveness',
  '/settings',
];

export function registerControlUiRoutes(app: FastifyInstance, deps: AppDeps): void {
  const enabled = () => deps.config.controlCenterEnabled;
  if (!enabled()) return;

  const asset = (mime: string, body: string) => async (_req: unknown, reply: FastifyReply) =>
    reply.header('Content-Type', mime).header('Cache-Control', 'public, max-age=300').send(body);

  app.get('/assets/control-center.css', asset('text/css; charset=utf-8', CSS));
  app.get('/assets/control-center.js', asset('text/javascript; charset=utf-8', JS));
  app.get('/assets/components.js', asset('text/javascript; charset=utf-8', COMPONENTS_JS));
  app.get('/assets/namespace-selector.mjs', asset('text/javascript; charset=utf-8', NAMESPACE_JS));
  app.get('/explore', async (_req, reply) => reply.redirect('/memories'));

  for (const path of UI_PATHS) {
    app.get(path, async (req, reply) => {
      if (!enabled()) return reply.code(404).send({ error: { code: 'feature_disabled', message: 'Control Center is disabled' } });
      if (!req.controlSession) return reply.redirect('/auth/login?return_to=' + encodeURIComponent(req.url.split('?')[0] ?? '/dashboard'));
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .send(HTML);
    });
  }
}
