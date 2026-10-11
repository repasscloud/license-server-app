/** @jsxImportSource hono/jsx */
// /portal — customer portal, /store + /checkout — public storefront and checkout status.
// Customer sessions are a separate realm from admin sessions and from machine credentials.
// Every licence/customer access is authorised by membership in that customer, with role checks;
// unauthorised resources return 404 (no enumeration).

import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { Db } from '../db/client.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import type { Actor } from '../services/actor.ts';
import { createBillingPortalSession } from '../services/billing.ts';
import { listPublicCatalogue } from '../services/catalogue.ts';
import { createCheckout, getCheckoutStatus } from '../services/checkout.ts';
import { addMember, listCustomerEntitlements, removeMember } from '../services/customers.ts';
import { consumeLoginLink, logout, requestLogin } from '../services/human-auth.ts';
import * as licensing from '../services/licensing.ts';
import { Badge, Csrf, fmt, Layout, money } from '../views/layout.tsx';
import { type AppEnv, type Ctx, logError, toAppError } from './context.ts';
import { clearSessionCookie, csrfGuard, formData, loadSession, setSessionCookie } from './session.ts';

type Role = 'owner' | 'admin' | 'billing' | 'member';
const MANAGE: Role[] = ['owner', 'admin'];
const BILLING: Role[] = ['owner', 'admin', 'billing'];

export const portalUi = new Hono<AppEnv>();
portalUi.use('*', csrfGuard('customer'));

const page = (c: Ctx, title: string, body: Child, flash?: { kind: 'ok' | 'err'; text: string } | null, status = 200) =>
  c.html(<Layout title={title} realm="customer" who={c.get('actor')?.label ?? null} csrf={c.get('csrf')} flash={flash ?? fromQuery(c)}>{body}</Layout>, status as 200);
const fromQuery = (c: Ctx) => (c.req.query('ok') ? { kind: 'ok' as const, text: c.req.query('ok')!.slice(0, 300) } : c.req.query('err') ? { kind: 'err' as const, text: c.req.query('err')!.slice(0, 300) } : null);
const back = (c: Ctx, msg: string, kind: 'ok' | 'err' = 'ok') => c.redirect(`/portal?${kind}=${encodeURIComponent(msg)}`, 303);

portalUi.get('/login', (c) => page(c, 'Sign in', (
  <div class="card"><h1>Customer portal sign-in</h1>
    <p class="muted">Enter the email address used for your purchase or registration. We will email you a single-use sign-in link (no password).</p>
    <form method="post" action="/portal/login"><Csrf token={c.get('csrf')} /><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required /><button type="submit">Email me a sign-in link</button></form></div>
)));

portalUi.post('/login', async (c) => {
  const f = await formData(c);
  try {
    await requestLogin(c.get('deps').sql, c.get('deps').config, 'customer', f.email ?? '', c.get('ipHash'), c.req.query('next'));
  } catch (e) {
    logError(c, e);
  }
  return page(c, 'Check your email', <div class="card"><h1>Check your email</h1><p>If we have an account for that address, a sign-in link is on its way. It expires in 15 minutes and works once.</p></div>);
});

portalUi.get('/auth/verify', (c) => page(c, 'Sign in', (
  <div class="card"><h1>Continue signing in</h1><form method="post" action="/portal/auth/verify"><Csrf token={c.get('csrf')} /><input type="hidden" name="token" value={c.req.query('token') ?? ''} /><button type="submit">Sign in</button></form></div>
)));

portalUi.post('/auth/verify', async (c) => {
  const f = await formData(c);
  try {
    const r = await consumeLoginLink(c.get('deps').sql, c.get('deps').config, 'customer', f.token ?? '', c.get('ipHash'));
    setSessionCookie(c, 'customer', r.sessionToken, 12 * 3600);
    return c.redirect(r.redirect, 303);
  } catch (e) {
    return page(c, 'Sign-in failed', <p><a href="/portal/login">Request a new link</a></p>, { kind: 'err', text: toAppError(e).message }, 401);
  }
});

portalUi.post('/logout', async (c) => {
  const s = await loadSession(c, 'customer');
  await logout(c.get('deps').sql, c.get('deps').config, 'customer', s?.token);
  clearSessionCookie(c, 'customer');
  return c.redirect('/portal/login', 303);
});

portalUi.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (['/portal/login', '/portal/auth/verify', '/portal/logout'].includes(path)) return next();
  const s = await loadSession(c, 'customer');
  if (!s) return c.redirect(`/portal/login?next=${encodeURIComponent(path)}`, 303);
  const [u] = await c.get('deps').sql<{ email: string; status: string }[]>`SELECT email, status FROM portal_users WHERE id = ${s.subjectId}`;
  if (!u || u.status !== 'active') {
    clearSessionCookie(c, 'customer');
    return c.redirect('/portal/login', 303);
  }
  const actor: Actor = { type: 'customer', id: s.subjectId, label: u.email, requestId: c.get('requestId'), ipHash: c.get('ipHash') };
  c.set('actor', actor);
  await next();
});

async function memberships(db: Db, userId: string) {
  return db<{ customer_id: string; role: Role; display_name: string; organisation_name: string | null; kind: string; stripe_customer_id: string | null }[]>`
    SELECT m.customer_id, m.role, c.display_name, c.organisation_name, c.kind, c.stripe_customer_id FROM customer_members m JOIN customers c ON c.id = m.customer_id
    WHERE m.portal_user_id = ${userId} AND c.status = 'active' ORDER BY c.created_at`;
}

/** Authorise access to a licence through customer membership. 404 when not permitted. */
async function licenceAccess(c: Ctx, licenseId: string, roles: Role[]): Promise<string> {
  const [r] = await c.get('deps').sql<{ customer_id: string; role: Role }[]>`
    SELECT e.customer_id, m.role FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id
    JOIN customer_members m ON m.customer_id = e.customer_id AND m.portal_user_id = ${c.get('actor').id}
    WHERE l.id = ${licenseId}`;
  if (!r || !roles.includes(r.role)) throw notFound('Licence');
  return r.customer_id;
}

async function customerAccess(c: Ctx, customerId: string, roles: Role[]) {
  const [r] = await c.get('deps').sql<{ role: Role }[]>`SELECT role FROM customer_members WHERE customer_id = ${customerId} AND portal_user_id = ${c.get('actor').id}`;
  if (!r || !roles.includes(r.role)) throw notFound('Customer');
}

function guarded(fn: (c: Ctx, f: Record<string, string>) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await fn(c, c.req.method === 'POST' ? await formData(c) : {});
    } catch (e) {
      const ae = toAppError(e);
      if (ae.status >= 500) logError(c, e);
      return back(c, ae.message, 'err');
    }
  };
}

portalUi.get('/', async (c) => {
  const sql = c.get('deps').sql;
  const ms = await memberships(sql, c.get('actor').id!);
  const sections = [];
  for (const m of ms) {
    const ents = await listCustomerEntitlements(sql, m.customer_id);
    const devices = await sql<{ id: string; license_id: string; device_id: string; activated_at: Date; last_validated_at: Date | null }[]>`
      SELECT a.id, a.license_id, a.device_id, a.activated_at, a.last_validated_at FROM activations a JOIN licenses l ON l.id = a.license_id JOIN entitlements e ON e.id = l.entitlement_id
      WHERE e.customer_id = ${m.customer_id} AND a.status = 'active' ORDER BY a.activated_at`;
    const transfer: Record<string, Awaited<ReturnType<typeof licensing.transferStatus>>> = {};
    for (const e of ents) if (e.activation_model === 'device_seats') transfer[e.license_id] = await licensing.transferStatus(sql, e.license_id);
    const members = MANAGE.includes(m.role) ? await sql<{ portal_user_id: string; email: string; role: string }[]>`SELECT m.portal_user_id, u.email, m.role FROM customer_members m JOIN portal_users u ON u.id = m.portal_user_id WHERE m.customer_id = ${m.customer_id}` : [];
    const manage = MANAGE.includes(m.role);
    sections.push(
      <section class="card">
        <h2>{m.organisation_name ?? m.display_name} <span class="muted">({m.role})</span></h2>
        {m.stripe_customer_id && BILLING.includes(m.role) ? <form class="inline" method="post" action={`/portal/customers/${m.customer_id}/billing`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Manage billing, payment methods and invoices (Stripe)</button></form> : null}
        {ents.length === 0 ? <p class="muted">No licences yet.</p> : null}
        {ents.map((e) => (
          <div class="card">
            <h3>{e.product_name} {e.major_version} — {e.edition_name} <Badge v={e.status} /></h3>
            <p>Licence <code>{e.license_id}</code> · {e.term_type === 'perpetual' ? 'perpetual (all ' + e.major_version + '.x releases)' : `${e.term_type}, valid until ${fmt(e.expires_at)}`}
              {e.expires_at && new Date(e.expires_at) < new Date() ? <> <Badge v="expired" /></> : null}</p>
            {e.status === 'revoked' ? <p class="muted">This licence was revoked. Contact support if you think this is a mistake.</p> : (
              <p><a class="button" href={`/portal/licenses/${e.license_id}/file`}>Download licence file</a>
                {manage && e.key_revealable ? <form class="inline" method="post" action={`/portal/licenses/${e.license_id}/reveal-key`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Reveal activation key (once)</button></form> : null}
                {manage ? <form class="inline" method="post" action={`/portal/licenses/${e.license_id}/rotate-key`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Rotate activation key</button></form> : null}
                <span class="muted"> Current key ends …{e.key_hint ?? '—'}</span></p>
            )}
            {e.activation_model === 'device_seats' ? (
              <>
                <p>Seats: {e.active_activations} of {e.seats} in use · transfers remaining in the last 12 months: {transfer[e.license_id]?.remaining ?? 0} of {transfer[e.license_id]?.allowance ?? 0}</p>
                <div class="table-wrap"><table><thead><tr><th>Activation</th><th>Device</th><th>Activated</th><th>Last seen</th><th></th></tr></thead><tbody>
                  {devices.filter((d) => d.license_id === e.license_id).map((d) => <tr><td><code>{d.id}</code></td><td>…{d.device_id.slice(-8)}</td><td>{fmt(d.activated_at)}</td><td>{fmt(d.last_validated_at)}</td>
                    <td>{manage ? <form class="inline" method="post" action={`/portal/activations/${d.id}/release`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Release device</button></form> : null}</td></tr>)}
                </tbody></table></div>
                <p class="muted">Releasing frees the seat immediately on the server. A device that is offline keeps its local activation until it next contacts the server (renew), when it is told the activation was released. Re-using a released seat for a new device counts as a transfer. Need more transfers? Email <a href={`mailto:${c.get('deps').config.supportEmail}?subject=${encodeURIComponent('Transfer request ' + e.license_id)}`}>{c.get('deps').config.supportEmail}</a>.</p>
              </>
            ) : <p class="muted">This edition does not track devices: install it on as many machines as your licence terms allow, fully offline.</p>}
          </div>
        ))}
        {manage ? (
          <details><summary>People with access</summary>
            <ul>{members.map((u) => <li>{u.email} ({u.role}) {u.portal_user_id !== c.get('actor').id && u.role !== 'owner' ? <form class="inline" method="post" action={`/portal/customers/${m.customer_id}/members/${u.portal_user_id}/remove`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Remove</button></form> : null}</li>)}</ul>
            <form method="post" action={`/portal/customers/${m.customer_id}/members`}><Csrf token={c.get('csrf')} /><label>Invite colleague (email)</label><input name="email" type="email" required /><label>Role</label><select name="role"><option>member</option><option>billing</option><option>admin</option></select><button type="submit">Add</button></form>
          </details>
        ) : null}
      </section>,
    );
  }
  return page(c, 'My licences', (
    <>
      <h1>My licences</h1>
      {ms.length === 0 ? <p>No products are linked to this email yet. <a href="/store">Visit the store</a>.</p> : sections}
      <div class="card"><h2>About revocation and privacy</h2>
        <p class="muted">Licence files are signed, not encrypted, and contain no email address. Revoking or releasing on the server takes effect when an installation next contacts the licensing server; an installation that stays offline is not remotely disabled. Support: <a href={`mailto:${c.get('deps').config.supportEmail}`}>{c.get('deps').config.supportEmail}</a>.</p></div>
    </>
  ));
});

portalUi.get('/licenses/:id/file', guarded(async (c) => {
  await licenceAccess(c, c.req.param('id')!, ['owner', 'admin', 'billing', 'member']);
  const f = await licensing.licenseFileForDownload(c.get('deps').sql, c.get('deps').config, c.get('actor'), c.req.param('id')!);
  c.header('Content-Disposition', `attachment; filename="${f.fileName}"`);
  return c.json(f.envelope);
}));

portalUi.post('/licenses/:id/reveal-key', guarded(async (c) => {
  await licenceAccess(c, c.req.param('id')!, MANAGE);
  const key = await licensing.revealActivationKey(c.get('deps').sql, c.get('deps').config, c.get('actor'), c.req.param('id')!);
  if (!key) return back(c, 'This key can no longer be revealed. Rotate it to get a new key.', 'err');
  return page(c, 'Activation key', <div class="card"><h1>Activation key</h1><p>Shown once — store it safely. Anyone with this key can activate your licence.</p><code class="secret">{key}</code><p><a href="/portal">Back</a></p></div>);
}));

portalUi.post('/licenses/:id/rotate-key', guarded(async (c) => {
  const customerId = await licenceAccess(c, c.req.param('id')!, MANAGE);
  const r = await licensing.rotateActivationKey(c.get('deps').sql, c.get('deps').config, c.get('actor'), c.req.param('id')!);
  void customerId;
  return page(c, 'New activation key', <div class="card"><h1>New activation key</h1><p>The previous key no longer works. Devices already activated keep working. This key is shown once.</p><code class="secret">{r.activationKey}</code><p><a href="/portal">Back</a></p></div>);
}));

portalUi.post('/activations/:id/release', guarded(async (c) => {
  const [a] = await c.get('deps').sql<{ license_id: string }[]>`SELECT license_id FROM activations WHERE id = ${c.req.param('id')!}`;
  if (!a) throw notFound('Activation');
  await licenceAccess(c, a.license_id, MANAGE);
  await licensing.releaseActivation(c.get('deps').sql, c.get('actor'), c.req.param('id')!, 'portal', c.get('deps').config);
  return back(c, 'Device released. An offline device learns about this the next time it renews.');
}));

portalUi.post('/customers/:id/billing', guarded(async (c) => {
  await customerAccess(c, c.req.param('id')!, BILLING);
  const url = await createBillingPortalSession(c.get('deps').sql, c.get('deps').config, c.get('deps').stripe, c.req.param('id')!);
  return c.redirect(url, 303);
}));

portalUi.post('/customers/:id/members', guarded(async (c, f) => {
  await customerAccess(c, c.req.param('id')!, MANAGE);
  if (!['member', 'billing', 'admin'].includes(f.role ?? '')) throw new AppError('validation_failed', 'Invalid role');
  await addMember(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.email ?? '', f.role as 'member', c.get('deps').config);
  return back(c, 'Access granted. They can sign in with their email address.');
}));

portalUi.post('/customers/:id/members/:userId/remove', guarded(async (c) => {
  await customerAccess(c, c.req.param('id')!, MANAGE);
  await removeMember(c.get('deps').sql, c.get('actor'), c.req.param('id')!, c.req.param('userId')!);
  return back(c, 'Access removed');
}));

// ----------------------------------------------------------------------------------------------
// Public store and checkout status
// ----------------------------------------------------------------------------------------------

export const storeUi = new Hono<AppEnv>();
storeUi.use('*', csrfGuard('customer'));

const pub = (c: Ctx, title: string, body: Child, flash?: { kind: 'ok' | 'err'; text: string } | null, status = 200) =>
  c.html(<Layout title={title} realm="public" flash={flash ?? null}>{body}</Layout>, status as 200);

storeUi.get('/store', async (c) => {
  const items = await listPublicCatalogue(c.get('deps').sql, new Date());
  return pub(c, 'Store', (
    <>
      <h1>Store</h1>
      {items.length === 0 ? <p class="muted">Nothing is on sale right now.</p> : null}
      <div class="grid">
        {items.map((i) => (
          <form class="card" method="post" action="/checkout">
            <Csrf token={c.get('csrf')} />
            <h2>{i.name}</h2><p class="muted">{i.products}</p><p>{i.description}</p>
            <p><b>{i.unit_amount === 0 ? 'Free' : money(i.unit_amount, i.currency)}</b>{i.recurring_interval ? ` per ${i.recurring_interval_count && i.recurring_interval_count > 1 ? i.recurring_interval_count + ' ' : ''}${i.recurring_interval}` : ''}</p>
            <input type="hidden" name="sku" value={i.sku} /><input type="hidden" name="currency" value={i.currency} />
            <input type="hidden" name="idempotencyKey" value={newId('req').replace('req_', 'ck_')} />
            <label for={`q-${i.sku}`}>Quantity</label><input id={`q-${i.sku}`} name="quantity" type="number" min="1" value="1" />
            <label for={`e-${i.sku}`}>Email</label><input id={`e-${i.sku}`} name="email" type="email" required autocomplete="email" />
            <button type="submit">{i.unit_amount === 0 ? 'Register' : 'Buy'}</button>
          </form>
        ))}
      </div>
      <p class="muted">Payment is processed by Stripe. Taxes, if applicable, are shown at checkout.</p>
    </>
  ));
});

storeUi.post('/checkout', async (c) => {
  const f = await formData(c);
  const { sql, config, stripe } = c.get('deps');
  try {
    // Only sku/currency/quantity/email/idempotency come from the browser; everything else is DB-resolved.
    const r = await createCheckout(sql, config, stripe, { type: 'customer', id: null, label: 'storefront', requestId: c.get('requestId'), ipHash: c.get('ipHash') },
      { sku: f.sku, currency: f.currency, quantity: Number(f.quantity || 1), email: f.email, idempotencyKey: f.idempotencyKey });
    if (r.url) return c.redirect(r.url, 303);
    return c.redirect(`/checkout/${r.id}/return`, 303);
  } catch (e) {
    const ae = toAppError(e);
    if (ae.status >= 500) logError(c, e);
    return pub(c, 'Checkout unavailable', <p><a href="/store">Back to store</a></p>, { kind: 'err', text: ae.message }, ae.status);
  }
});

// The success redirect is NOT proof of payment: this page only reports server-side state that
// is set by verified Stripe webhooks / reconciliation.
storeUi.get('/checkout/:id/return', async (c) => {
  try {
    const s = await getCheckoutStatus(c.get('deps').sql, c.req.param('id'));
    const msg: Record<string, string> = {
      completed: 'Payment confirmed. Your licence details have been emailed and are available in the customer portal.',
      open: 'We are waiting for confirmation from Stripe. This usually takes a few seconds — refresh this page.',
      awaiting_payment: 'Your payment is processing (some payment methods take longer). We will email you when it completes.',
      failed: 'The payment could not be completed. You have not been charged for a licence; please try again or contact support.',
      expired: 'This checkout expired. Please start again from the store.',
      creating: 'Checkout is being prepared. Refresh in a moment.',
    };
    return pub(c, 'Order status', (
      <div class="card"><h1>Order status: <Badge v={s.status} /></h1><p>{s.offerName}</p><p>{msg[s.status] ?? s.status}</p>
        {s.status === 'completed' ? <p><a class="button" href="/portal">Go to the customer portal</a></p> : <p><a class="button secondary" href={`/checkout/${s.id}/return`}>Refresh</a></p>}</div>
    ));
  } catch {
    return pub(c, 'Not found', <p>Unknown checkout.</p>, null, 404);
  }
});

storeUi.get('/checkout/:id/cancelled', (c) => pub(c, 'Checkout cancelled', <div class="card"><h1>Checkout cancelled</h1><p>No payment was taken. <a href="/store">Return to the store</a>.</p></div>));
storeUi.get('/checkout/:id/status.json', async (c) => {
  try {
    const s = await getCheckoutStatus(c.get('deps').sql, c.req.param('id'));
    return c.json({ id: s.id, status: s.status });
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
});
