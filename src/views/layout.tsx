/** @jsxImportSource hono/jsx */
import type { Child, FC } from 'hono/jsx';

export const Layout: FC<{ title: string; realm: 'admin' | 'customer' | 'public'; who?: string | null; csrf?: string; flash?: { kind: 'ok' | 'err'; text: string } | null; children?: Child }> = (p) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{p.title} · RePassCloud Licensing</title>
      <link rel="stylesheet" href="/assets/app.css" />
      <script src="/assets/app.js" defer></script>
    </head>
    <body>
      <header class="top">
        <span class="brand">RePassCloud {p.realm === 'admin' ? 'Admin' : p.realm === 'customer' ? 'Portal' : 'Licensing'}</span>
        {p.realm === 'admin' && p.who ? (
          <nav aria-label="Admin">
            <a href="/admin">Overview</a><a href="/admin/products">Products</a><a href="/admin/offers">Offers</a><a href="/admin/customers">Customers</a>
            <a href="/admin/licenses">Licences</a><a href="/admin/keys">Signing keys</a><a href="/admin/billing">Billing</a><a href="/admin/email">Email</a>
            <a href="/admin/access">Access</a><a href="/admin/audit">Audit</a>
          </nav>
        ) : null}
        {p.realm === 'customer' && p.who ? (<nav aria-label="Portal"><a href="/portal">My licences</a><a href="/store">Store</a></nav>) : null}
        {p.realm === 'public' ? (<nav aria-label="Site"><a href="/store">Store</a><a href="/portal">Customer portal</a></nav>) : null}
        {p.who ? (
          <span class="who">
            {p.who}{' '}
            <form class="inline" method="post" action={p.realm === 'admin' ? '/admin/logout' : '/portal/logout'}>
              <input type="hidden" name="_csrf" value={p.csrf ?? ''} />
              <button class="secondary" type="submit">Sign out</button>
            </form>
          </span>
        ) : null}
      </header>
      <main>
        {p.flash ? <div class={`flash ${p.flash.kind}`} role={p.flash.kind === 'err' ? 'alert' : 'status'}>{p.flash.text}</div> : null}
        {p.children}
      </main>
    </body>
  </html>
);

export const Csrf: FC<{ token: string }> = ({ token }) => <input type="hidden" name="_csrf" value={token} />;

export const Badge: FC<{ v: string }> = ({ v }) => {
  const ok = ['active', 'synced', 'published', 'completed', 'processed', 'sent', 'delivered', 'done', 'shipped', 'success', 'applied', 'created'];
  const bad = ['revoked', 'failed', 'dead', 'compromised', 'drifted', 'disabled', 'denied', 'failure', 'bounced', 'expired', 'error'];
  return <span class={`badge ${ok.includes(v) ? 'ok' : bad.includes(v) ? 'bad' : 'warn'}`}>{v}</span>;
};

export const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '—');
export { money } from '../lib/money.ts';
