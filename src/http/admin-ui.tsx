/** @jsxImportSource hono/jsx */
// /admin — administrator portal (server-rendered). Uses exactly the same service functions and
// permission checks as the admin REST API. Authentication: email link + TOTP (mandatory);
// high-risk actions require a TOTP step-up within 15 minutes.

import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import { ALL_PERMISSIONS, HIGH_RISK_SCOPES } from '../auth/permissions.ts';
import { ALGORITHMS, isSignatureAlgorithm } from '../crypto/algorithms.ts';
import { AppError } from '../lib/errors.ts';
import type { Actor } from '../services/actor.ts';
import { listAudit } from '../services/audit.ts';
import * as admins from '../services/admins.ts';
import * as billing from '../services/billing.ts';
import * as catalogue from '../services/catalogue.ts';
import { listCheckouts } from '../services/checkout.ts';
import * as customers from '../services/customers.ts';
import * as email from '../services/email.ts';
import { getLicenseDetail, grantEntitlements, searchLicenses } from '../services/entitlements.ts';
import { assertCodeShape, beginTotpEnrolment, consumeLoginLink, logout, requestLogin, adminTotpEnrolled, verifyAdminTotp } from '../services/human-auth.ts';
import { listJobs, retryDeadJob } from '../services/jobs.ts';
import * as licensing from '../services/licensing.ts';
import * as keys from '../services/signing-keys.ts';
import * as stripeSync from '../services/stripe-sync.ts';
import { Badge, Csrf, fmt, Layout, money } from '../views/layout.tsx';
import { type AppEnv, type Ctx, logError, toAppError } from './context.ts';
import { bool, clearSessionCookie, csrfGuard, formData, loadSession, numOrNull, setSessionCookie, strOrNull, type RealmSession } from './session.ts';

export const adminUi = new Hono<AppEnv>();
adminUi.use('*', csrfGuard('admin'));

type Page = { title: string; body: Child; flash?: { kind: 'ok' | 'err'; text: string } | null };
const render = (c: Ctx, p: Page, status = 200) =>
  c.html(<Layout title={p.title} realm="admin" who={c.get('actor')?.label ?? null} csrf={c.get('csrf')} flash={p.flash ?? flashFromQuery(c)}>{p.body}</Layout>, status as 200);

function flashFromQuery(c: Ctx): Page['flash'] {
  const ok = c.req.query('ok');
  const err = c.req.query('err');
  if (ok) return { kind: 'ok', text: ok.slice(0, 300) };
  if (err) return { kind: 'err', text: err.slice(0, 300) };
  return null;
}

/** Same-origin referer path within /admin, for "Go back" links (no javascript: URLs under CSP). */
function safeBack(c: Ctx): string {
  try {
    const r = new URL(c.req.header('referer') ?? '');
    if (r.origin === new URL(c.req.url).origin && r.pathname.startsWith('/admin')) return r.pathname + r.search;
  } catch {
    /* no referer */
  }
  return '/admin';
}

const back = (c: Ctx, path: string, msg: string, kind: 'ok' | 'err' = 'ok') => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`, 303);
const can = (c: Ctx, p: string) => c.get('actor')?.permissions?.has(p) ?? false;

/** Run a mutation; on error re-render a truthful error page (step-up hint when relevant). */
function action(fn: (c: Ctx, f: Record<string, string>) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await fn(c, await formData(c));
    } catch (e) {
      const ae = toAppError(e);
      if (ae.status >= 500) logError(c, e);
      const stepUp = ae.code === 'forbidden' && /step-up/.test(ae.message);
      const details = Array.isArray(ae.details) ? (ae.details as Array<{ path?: string; message: string }>).map((d) => `${d.path ? d.path + ': ' : ''}${d.message}`).join('; ') : '';
      return render(c, {
        title: 'Action failed',
        flash: { kind: 'err', text: `${ae.message}${details ? ` — ${details}` : ''}` },
        body: <div class="card">{stepUp ? <p><a class="button" href={`/admin/step-up?next=${encodeURIComponent(c.req.header('referer') ? new URL(c.req.header('referer')!).pathname : '/admin')}`}>Verify with authenticator</a></p> : null}<p><a href={safeBack(c)}>Go back</a> · <a href="/admin">Overview</a></p></div>,
      }, ae.status);
    }
  };
}

// --------------------------------------------------------------------------------------------
// Authentication (public within /admin)
// --------------------------------------------------------------------------------------------

adminUi.get('/login', (c) => render(c, {
  title: 'Administrator sign-in',
  body: (
    <div class="card">
      <h1>Administrator sign-in</h1>
      <p class="muted">We email a single-use sign-in link. You will then need the code from your authenticator app.</p>
      <form method="post" action="/admin/login">
        <Csrf token={c.get('csrf')} />
        <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required />
        <button type="submit">Email me a sign-in link</button>
      </form>
    </div>
  ),
}));

adminUi.post('/login', async (c) => {
  const f = await formData(c);
  const { sql, config } = c.get('deps');
  try {
    await requestLogin(sql, config, 'admin', f.email ?? '', c.get('ipHash'), c.req.query('next'));
  } catch (e) {
    logError(c, e);
  }
  return render(c, { title: 'Check your email', body: <div class="card"><h1>Check your email</h1><p>If that address belongs to an administrator, a sign-in link is on its way. It expires in 15 minutes.</p></div> });
});

// GET shows a confirmation button (so email link scanners cannot consume the token).
adminUi.get('/auth/verify', (c) => render(c, {
  title: 'Continue sign-in',
  body: <div class="card"><h1>Continue sign-in</h1><form method="post" action="/admin/auth/verify"><Csrf token={c.get('csrf')} /><input type="hidden" name="token" value={c.req.query('token') ?? ''} /><button type="submit">Continue</button></form></div>,
}));

adminUi.post('/auth/verify', async (c) => {
  const f = await formData(c);
  try {
    const r = await consumeLoginLink(c.get('deps').sql, c.get('deps').config, 'admin', f.token ?? '', c.get('ipHash'));
    setSessionCookie(c, 'admin', r.sessionToken, 8 * 3600);
    return c.redirect('/admin/mfa', 303);
  } catch (e) {
    return render(c, { title: 'Sign-in failed', flash: { kind: 'err', text: toAppError(e).message }, body: <p><a href="/admin/login">Request a new link</a></p> }, 401);
  }
});

async function pending(c: Ctx): Promise<RealmSession | null> {
  const s = await loadSession(c, 'admin');
  return s;
}

adminUi.get('/mfa', async (c) => {
  const s = await pending(c);
  if (!s) return c.redirect('/admin/login', 303);
  const { sql, config } = c.get('deps');
  const enrolled = await adminTotpEnrolled(sql, s.subjectId);
  let enrol: { otpauthUri: string; secretBase32: string } | null = null;
  if (!enrolled) enrol = await beginTotpEnrolment(sql, config, s);
  return render(c, {
    title: 'Authenticator code',
    body: (
      <div class="card">
        <h1>{enrolled ? 'Enter your authenticator code' : 'Set up your authenticator'}</h1>
        {enrol ? (
          <div>
            <p>Add this account to an authenticator app (TOTP, 6 digits, 30 seconds), then enter the current code. Keep this secret private.</p>
            <p>Setup key: <code class="secret">{enrol.secretBase32}</code></p>
            <details><summary>otpauth URI</summary><code>{enrol.otpauthUri}</code></details>
          </div>
        ) : null}
        <form method="post" action="/admin/mfa">
          <Csrf token={c.get('csrf')} />
          <label for="code">6-digit code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required />
          <button type="submit">Verify</button>
        </form>
      </div>
    ),
  });
});

adminUi.post('/mfa', async (c) => {
  const s = await pending(c);
  if (!s) return c.redirect('/admin/login', 303);
  const f = await formData(c);
  try {
    await verifyAdminTotp(c.get('deps').sql, c.get('deps').config, s, assertCodeShape(f.code), c.get('ipHash'));
    return c.redirect(f.next && f.next.startsWith('/admin') ? f.next : '/admin', 303);
  } catch (e) {
    return back(c, '/admin/mfa', toAppError(e).message, 'err');
  }
});

adminUi.post('/logout', async (c) => {
  const s = await loadSession(c, 'admin');
  await logout(c.get('deps').sql, c.get('deps').config, 'admin', s?.token);
  clearSessionCookie(c, 'admin');
  return c.redirect('/admin/login', 303);
});

// Everything below requires an active (MFA-complete) admin session.
adminUi.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (['/admin/login', '/admin/auth/verify', '/admin/mfa', '/admin/logout'].includes(path)) return next();
  const s = await loadSession(c, 'admin');
  if (!s) return c.redirect(`/admin/login?next=${encodeURIComponent(path)}`, 303);
  if (s.state !== 'active') return c.redirect('/admin/mfa', 303);
  const actor = await admins.adminActor(c.get('deps').sql, s.subjectId, { mfaAt: s.mfaAt, requestId: c.get('requestId'), ipHash: c.get('ipHash') });
  if (!actor) {
    clearSessionCookie(c, 'admin');
    return c.redirect('/admin/login', 303);
  }
  c.set('actor', actor);
  c.set('sessionToken', s.token);
  await next();
});

adminUi.get('/step-up', (c) => render(c, {
  title: 'Verify it is you',
  body: <div class="card"><h1>Verify with your authenticator</h1><p class="muted">High-risk actions require a code from the last 15 minutes.</p>
    <form method="post" action="/admin/step-up"><Csrf token={c.get('csrf')} /><input type="hidden" name="next" value={c.req.query('next') ?? '/admin'} />
      <label for="code">6-digit code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required /><button type="submit">Verify</button></form></div>,
}));
adminUi.post('/step-up', action(async (c, f) => {
  const s = await loadSession(c, 'admin');
  await verifyAdminTotp(c.get('deps').sql, c.get('deps').config, s!, assertCodeShape(f.code), c.get('ipHash'));
  return back(c, f.next?.startsWith('/admin') ? f.next : '/admin', 'Verified. You can retry the action now.');
}));

// --------------------------------------------------------------------------------------------
// Overview
// --------------------------------------------------------------------------------------------

adminUi.get('/', async (c) => {
  const sql = c.get('deps').sql;
  const [s] = await sql<Record<string, number>[]>`
    SELECT (SELECT count(*)::int FROM customers) AS customers,
           (SELECT count(*)::int FROM entitlements WHERE status = 'active') AS active_entitlements,
           (SELECT count(*)::int FROM activations WHERE status = 'active') AS active_devices,
           (SELECT count(*)::int FROM offers WHERE status = 'active') AS active_offers,
           (SELECT count(*)::int FROM outbox_jobs WHERE status = 'dead') AS dead_jobs,
           (SELECT count(*)::int FROM email_outbox WHERE status IN ('dead', 'uncertain')) AS email_attention,
           (SELECT count(*)::int FROM stripe_events WHERE status IN ('failed', 'dead')) AS stripe_failed,
           (SELECT count(*)::int FROM stripe_price_mappings WHERE sync_state IN ('failed', 'drifted')) AS mapping_attention,
           (SELECT count(*)::int FROM entitlements WHERE review_required) AS review_required`;
  const missing = c.get('deps').config.missingSecrets();
  const recent: ReadonlyArray<Awaited<ReturnType<typeof listAudit>>[number]> = can(c, 'audit:read') ? await listAudit(sql, { limit: 15 }) : [];
  return render(c, {
    title: 'Overview',
    body: (
      <>
        <h1>Overview</h1>
        {missing.length ? <div class="flash err" role="alert">Missing configuration (features fail closed): {missing.join(', ')}</div> : null}
        <div class="grid">
          {Object.entries(s ?? {}).map(([k, v]) => <div class="card stat"><span class="muted">{k.replace(/_/g, ' ')}</span><b>{v}</b></div>)}
        </div>
        <p class="muted">Mail transport: <b>{c.get('deps').config.mailTransport}</b> · Stripe mode: <b>{c.get('deps').stripe.livemode ? 'live' : 'test'}</b> · Environment: <b>{c.get('deps').config.environment}</b></p>
        {recent.length ? <><h2>Recent activity</h2><AuditTable rows={recent} /></> : null}
      </>
    ),
  });
});

const AuditTable = ({ rows }: { rows: ReadonlyArray<Awaited<ReturnType<typeof listAudit>>[number]> }) => (
  <div class="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>
    {rows.map((r) => <tr><td>{fmt(r.occurred_at)}</td><td>{r.actor_type}<br /><span class="muted mono">{r.actor_id ?? ''}</span></td><td>{r.action}</td><td>{r.resource_type ?? ''} <span class="mono">{r.resource_id ?? ''}</span></td><td><Badge v={r.outcome} /></td><td><code>{JSON.stringify(r.detail).slice(0, 220)}</code></td></tr>)}
  </tbody></table></div>
);

// --------------------------------------------------------------------------------------------
// Products, majors, releases, edition policies
// --------------------------------------------------------------------------------------------

adminUi.get('/products', async (c) => {
  const rows = await catalogue.listProducts(c.get('deps').sql, { search: c.req.query('q'), limit: 200 });
  return render(c, {
    title: 'Products',
    body: (
      <>
        <h1>Products</h1>
        <div class="table-wrap"><table><thead><tr><th>Product id</th><th>Name</th><th>Status</th><th>Visibility</th><th>Majors</th></tr></thead><tbody>
          {rows.map((p) => <tr><td><a href={`/admin/products/${p.id}`}><code>{p.slug}</code></a></td><td>{p.name}</td><td><Badge v={p.status} /></td><td>{p.visibility}</td><td>{p.majors}</td></tr>)}
        </tbody></table></div>
        {can(c, 'products:write') ? (
          <div class="card"><h2>New product</h2>
            <form method="post" action="/admin/products"><Csrf token={c.get('csrf')} />
              <div class="row"><div><label for="slug">Product id (immutable wire productId)</label><input id="slug" name="slug" pattern="[a-z0-9][a-z0-9_.-]{0,63}" required /></div>
                <div><label for="name">Name</label><input id="name" name="name" required /></div></div>
              <label for="description">Description</label><textarea id="description" name="description"></textarea>
              <label for="visibility">Visibility</label><select id="visibility" name="visibility"><option>public</option><option>private</option></select>
              <button type="submit">Create product (draft)</button>
            </form></div>
        ) : null}
      </>
    ),
  });
});

adminUi.post('/products', action(async (c, f) => {
  const p = await catalogue.createProduct(c.get('deps').sql, c.get('actor'), { slug: f.slug, name: f.name, description: f.description ?? '', visibility: f.visibility });
  return back(c, `/admin/products/${p.id}`, 'Product created');
}));

adminUi.get('/products/:id', async (c) => {
  const sql = c.get('deps').sql;
  const p = await catalogue.getProduct(sql, c.req.param('id'));
  return render(c, {
    title: p.name,
    body: (
      <>
        <h1>{p.name} <code>{p.slug}</code> <Badge v={p.status} /></h1>
        {can(c, 'products:write') ? (
          <div class="card"><form method="post" action={`/admin/products/${p.id}`}><Csrf token={c.get('csrf')} />
            <div class="row"><div><label for="name">Name</label><input id="name" name="name" value={p.name} /></div>
              <div><label for="status">Status</label><select id="status" name="status">{['draft', 'active', 'retired'].map((s) => <option selected={s === p.status}>{s}</option>)}</select></div>
              <div><label for="visibility">Visibility</label><select id="visibility" name="visibility">{['public', 'private'].map((s) => <option selected={s === p.visibility}>{s}</option>)}</select></div></div>
            <label for="description">Description</label><textarea id="description" name="description">{p.description}</textarea>
            <button type="submit">Save</button></form></div>
        ) : null}
        <h2>Major versions</h2>
        <div class="table-wrap"><table><thead><tr><th>Major</th><th>Protocol</th><th>Status</th><th>Default transfers</th><th>Key in email</th></tr></thead><tbody>
          {p.majors.map((m) => <tr><td><a href={`/admin/majors/${m.id}`}>v{m.major_version}</a></td><td><code>{m.protocol_id}</code></td><td><Badge v={m.status} /></td><td>{m.default_transfer_allowance}</td><td>{m.activation_key_email ? 'yes' : 'portal only'}</td></tr>)}
        </tbody></table></div>
        {can(c, 'products:write') ? (
          <div class="card"><h2>New major version</h2><form method="post" action="/admin/majors"><Csrf token={c.get('csrf')} /><input type="hidden" name="productId" value={p.id} />
            <div class="row"><div><label for="majorVersion">Major</label><input id="majorVersion" name="majorVersion" type="number" min="0" required /></div>
              <div><label for="protocolId">Wire protocol</label><select id="protocolId" name="protocolId"><option>repass-v1</option></select></div>
              <div><label for="defaultTransferAllowance">Default transfers / 365 days</label><input id="defaultTransferAllowance" name="defaultTransferAllowance" type="number" min="0" value="3" /></div></div>
            <label><input type="checkbox" name="activationKeyEmail" checked /> Include activation keys in purchase email</label>
            <button type="submit">Create major (draft)</button></form></div>
        ) : null}
      </>
    ),
  });
});

adminUi.post('/products/:id', action(async (c, f) => {
  await catalogue.updateProduct(c.get('deps').sql, c.get('actor'), c.req.param('id')!, { name: f.name, description: f.description, status: f.status, visibility: f.visibility });
  return back(c, `/admin/products/${c.req.param('id')}`, 'Saved');
}));

adminUi.post('/majors', action(async (c, f) => {
  const m = await catalogue.createMajor(c.get('deps').sql, c.get('actor'), { productId: f.productId, majorVersion: Number(f.majorVersion), protocolId: f.protocolId, defaultTransferAllowance: Number(f.defaultTransferAllowance ?? 3), activationKeyEmail: bool(f.activationKeyEmail) });
  return back(c, `/admin/majors/${m.id}`, 'Major created');
}));

adminUi.get('/majors/:id', async (c) => {
  const sql = c.get('deps').sql;
  const m = await catalogue.getMajor(sql, c.req.param('id'));
  const editions = await sql<{ id: string; name: string }[]>`SELECT id, name FROM edition_definitions ORDER BY id`;
  const compat = await keys.listCompatibilities(sql, { productMajorId: m.id });
  const w = can(c, 'products:write');
  return render(c, {
    title: `${m.product_name} v${m.major_version}`,
    body: (
      <>
        <h1><a href={`/admin/products/${m.product_id}`}>{m.product_name}</a> v{m.major_version} <Badge v={m.status} /></h1>
        <p class="muted">Protocol <code>{m.protocol_id}</code> · licence file name template <code>{(m as unknown as { licence_file_name_template: string }).licence_file_name_template}</code></p>
        {w ? (<div class="card"><form method="post" action={`/admin/majors/${m.id}`}><Csrf token={c.get('csrf')} />
          <div class="row"><div><label for="status">Status</label><select id="status" name="status">{['draft', 'active', 'sales_closed', 'retired'].map((s) => <option selected={s === m.status}>{s}</option>)}</select></div>
            <div><label for="dta">Default transfers</label><input id="dta" name="defaultTransferAllowance" type="number" min="0" value={String(m.default_transfer_allowance)} /></div></div>
          <label><input type="checkbox" name="activationKeyEmail" checked={m.activation_key_email} /> Include activation keys in purchase email</label>
          <button type="submit">Save major</button></form></div>) : null}
        <h2>Releases</h2>
        <div class="table-wrap"><table><thead><tr><th>Version</th><th>Status</th><th>Minimum supported</th><th>Shipped</th></tr></thead><tbody>
          {m.releases.map((r) => <tr><td><code>{r.version}</code></td><td><Badge v={r.status} /></td><td>{r.is_minimum_supported ? 'yes' : ''}</td><td>{fmt(r.shipped_at)}</td></tr>)}
        </tbody></table></div>
        {w ? (<details class="card"><summary>Add or update a release</summary><form method="post" action={`/admin/majors/${m.id}/releases`}><Csrf token={c.get('csrf')} />
          <div class="row"><div><label for="version">Version</label><input id="version" name="version" placeholder={`${m.major_version}.1.0`} required /></div>
            <div><label for="rstatus">Status</label><select id="rstatus" name="status"><option>planned</option><option>shipped</option><option>withdrawn</option></select></div></div>
          <label><input type="checkbox" name="isMinimumSupported" /> Minimum supported release (key eligibility depends on it)</label>
          <button type="submit">Save release</button></form></details>) : null}
        <h2>Edition policies</h2>
        <div class="table-wrap"><table><thead><tr><th>Edition</th><th>Display</th><th>Activation</th><th>Ownership</th><th>Transfers</th><th>Cert lifetime</th><th>Offline</th><th>Status</th></tr></thead><tbody>
          {m.editions.map((e) => <tr><td><code>{e.wire_id}</code></td><td>{e.display_name}</td><td>{e.activation_model}</td><td>{e.ownership}</td><td>{e.transfer_allowance ?? 'default'}</td><td>{e.certificate_lifetime_seconds ?? 'none'}</td><td>{e.offline_policy}</td><td><Badge v={e.status} /></td></tr>)}
        </tbody></table></div>
        {w ? (<details class="card"><summary>Add or update an edition policy</summary><form method="post" action={`/admin/majors/${m.id}/editions`}><Csrf token={c.get('csrf')} />
          <div class="row"><div><label for="editionId">Edition label</label><select id="editionId" name="editionId">{editions.map((e) => <option value={e.id}>{e.name}</option>)}</select></div>
            <div><label for="displayName">Display name</label><input id="displayName" name="displayName" required /></div>
            <div><label for="activationModel">Activation model</label><select id="activationModel" name="activationModel"><option value="none">none (provision only)</option><option value="device_seats">device seats</option></select></div>
            <div><label for="ownership">Ownership</label><select id="ownership" name="ownership"><option>individual</option><option>organisation</option><option>institution</option></select></div></div>
          <div class="row"><div><label for="transferAllowance">Transfers / 365 days (blank = major default)</label><input id="transferAllowance" name="transferAllowance" type="number" min="0" /></div>
            <div><label for="cert">Certificate lifetime seconds (blank = none)</label><input id="cert" name="certificateLifetimeSeconds" type="number" min="3600" /></div>
            <div><label for="offlinePolicy">Offline policy</label><select id="offlinePolicy" name="offlinePolicy"><option>indefinite</option><option>periodic_check</option></select></div></div>
          <p class="muted">Combinations the major's wire protocol cannot express are rejected (ADR-0001).</p>
          <button type="submit">Save edition policy</button></form></details>) : null}
        <h2>Signing-key trust</h2>
        <KeyCompatTable rows={compat} />
        <p><a href="/admin/keys">Manage signing keys</a></p>
      </>
    ),
  });
});

adminUi.post('/majors/:id', action(async (c, f) => {
  await catalogue.updateMajor(c.get('deps').sql, c.get('actor'), c.req.param('id')!, { status: f.status, defaultTransferAllowance: Number(f.defaultTransferAllowance), activationKeyEmail: bool(f.activationKeyEmail) });
  return back(c, `/admin/majors/${c.req.param('id')}`, 'Saved');
}));
adminUi.post('/majors/:id/releases', action(async (c, f) => {
  await catalogue.upsertRelease(c.get('deps').sql, c.get('actor'), { productMajorId: c.req.param('id'), version: f.version, status: f.status, isMinimumSupported: bool(f.isMinimumSupported) });
  return back(c, `/admin/majors/${c.req.param('id')}`, 'Release saved');
}));
adminUi.post('/majors/:id/editions', action(async (c, f) => {
  await catalogue.upsertEditionPolicy(c.get('deps').sql, c.get('actor'), {
    productMajorId: c.req.param('id'), editionId: f.editionId, displayName: f.displayName, activationModel: f.activationModel, ownership: f.ownership,
    transferAllowance: numOrNull(f.transferAllowance), certificateLifetimeSeconds: numOrNull(f.certificateLifetimeSeconds), offlinePolicy: f.offlinePolicy,
  });
  return back(c, `/admin/majors/${c.req.param('id')}`, 'Edition policy saved');
}));

const KeyCompatTable = ({ rows }: { rows: keys.CompatibilityView[] }) => (
  <div class="table-wrap"><table><thead><tr><th>Key</th><th>Algorithm</th><th>Product</th><th>Trusted since</th><th>Until</th><th>Eligible</th><th>Effective</th></tr></thead><tbody>
    {rows.map((r) => <tr><td><code>{r.keyId}</code></td><td>{r.algorithm}</td><td>{r.productSlug} v{r.majorVersion}</td><td>{r.trustedSinceVersion}</td><td>{r.trustedUntilVersion ?? '—'}</td><td>{r.eligible ? 'yes' : 'no'}</td>
      <td>{r.effectiveEligible ? <Badge v="active" /> : <span class="muted">{r.blockedReason ?? 'not eligible'}</span>}</td></tr>)}
  </tbody></table></div>
);

// --------------------------------------------------------------------------------------------
// Offers and prices
// --------------------------------------------------------------------------------------------

adminUi.get('/offers', async (c) => {
  const sql = c.get('deps').sql;
  const rows = await catalogue.listOffers(sql, { limit: 200 });
  const policies = await sql<{ id: string; label: string }[]>`
    SELECT ep.id, p.slug || ' v' || m.major_version || ' — ' || ep.display_name || ' (' || ep.activation_model || ')' AS label
    FROM product_edition_policies ep JOIN product_majors m ON m.id = ep.product_major_id JOIN products p ON p.id = m.product_id WHERE ep.status = 'active' ORDER BY 2`;
  const compRow = (i: number) => (
    <fieldset class="card"><legend>Component {i + 1}{i > 0 ? ' (optional, bundles)' : ''}</legend>
      <div class="row"><div><label for={`ep${i}`}>Product edition</label><select id={`ep${i}`} name={`c${i}_editionPolicyId`}>{i > 0 ? <option value="">— none —</option> : null}{policies.map((p) => <option value={p.id}>{p.label}</option>)}</select></div>
        <div><label for={`tt${i}`}>Term</label><select id={`tt${i}`} name={`c${i}_termType`}><option>perpetual</option><option>subscription</option><option>fixed_term</option></select></div>
        <div><label for={`ti${i}`}>Fixed-term length</label><div class="row"><input id={`ti${i}`} name={`c${i}_termIntervalCount`} type="number" min="1" placeholder="count" /><select name={`c${i}_termInterval`}><option value="">—</option><option>day</option><option>week</option><option>month</option><option>year</option></select></div></div></div>
      <div class="row"><div><label for={`s${i}`}>Seats per unit (device editions)</label><input id={`s${i}`} name={`c${i}_seatsPerUnit`} type="number" min="1" /></div>
        <div><label><input type="checkbox" name={`c${i}_quantityScalesSeats`} /> Quantity multiplies seats</label></div>
        <div><label for={`tr${i}`}>Trial days (subscriptions)</label><input id={`tr${i}`} name={`c${i}_trialDays`} type="number" min="1" /></div>
        <div><label for={`g${i}`}>Grace days</label><input id={`g${i}`} name={`c${i}_graceDays`} type="number" min="0" max="90" value="0" /></div></div>
      <div class="row"><div><label for={`ra${i}`}>On full refund</label><select id={`ra${i}`} name={`c${i}_refundAction`}><option>revoke</option><option>review</option><option>none</option></select></div>
        <div><label for={`da${i}`}>On dispute</label><select id={`da${i}`} name={`c${i}_disputeAction`}><option>review</option><option>revoke</option><option>none</option></select></div></div>
    </fieldset>
  );
  return render(c, {
    title: 'Offers',
    body: (
      <>
        <h1>Offers (SKUs)</h1>
        <div class="table-wrap"><table><thead><tr><th>SKU</th><th>Name</th><th>Kind</th><th>Billing</th><th>Status</th><th>Components</th><th>Active prices</th></tr></thead><tbody>
          {rows.map((o) => <tr><td><a href={`/admin/offers/${o.id}`}><code>{o.sku}</code></a></td><td>{o.name}</td><td>{o.kind}</td><td>{o.billing}</td><td><Badge v={o.status} /></td><td>{o.components}</td><td>{o.active_prices}</td></tr>)}
        </tbody></table></div>
        {can(c, 'products:write') ? (
          <details class="card"><summary>New offer</summary>
            <form method="post" action="/admin/offers"><Csrf token={c.get('csrf')} />
              <div class="row"><div><label for="sku">SKU</label><input id="sku" name="sku" pattern="[A-Za-z0-9_.-]{1,100}" required /></div><div><label for="oname">Name</label><input id="oname" name="name" required /></div>
                <div><label for="billing">Billing</label><select id="billing" name="billing"><option value="one_time">one-time</option><option value="recurring">recurring (subscription)</option><option value="free">free registration</option></select></div></div>
              <div class="row"><div><label for="maxQuantity">Max quantity</label><input id="maxQuantity" name="maxQuantity" type="number" min="1" value="1" /></div>
                <div><label for="customerKind">Customer kind</label><select id="customerKind" name="customerKind"><option>any</option><option>individual</option><option>organisation</option></select></div>
                <div><label for="ovis">Visibility</label><select id="ovis" name="visibility"><option>public</option><option>private</option></select></div></div>
              <div class="row"><label><input type="checkbox" name="allowPromotionCodes" /> Allow promotion codes</label><label><input type="checkbox" name="automaticTax" /> Stripe Tax (automatic tax)</label><label><input type="checkbox" name="taxIdCollection" /> Collect tax IDs</label></div>
              <label for="odesc">Description</label><textarea id="odesc" name="description"></textarea>
              {[0, 1, 2].map(compRow)}
              <button type="submit">Create offer (draft)</button>
            </form></details>
        ) : null}
      </>
    ),
  });
});

adminUi.post('/offers', action(async (c, f) => {
  const components = [0, 1, 2].filter((i) => f[`c${i}_editionPolicyId`]).map((i) => ({
    editionPolicyId: f[`c${i}_editionPolicyId`], termType: f[`c${i}_termType`], termInterval: strOrNull(f[`c${i}_termInterval`]), termIntervalCount: numOrNull(f[`c${i}_termIntervalCount`]),
    seatsPerUnit: numOrNull(f[`c${i}_seatsPerUnit`]), quantityScalesSeats: bool(f[`c${i}_quantityScalesSeats`]), trialDays: numOrNull(f[`c${i}_trialDays`]),
    graceDays: Number(f[`c${i}_graceDays`] || 0), refundAction: f[`c${i}_refundAction`], disputeAction: f[`c${i}_disputeAction`],
  }));
  const o = await catalogue.createOffer(c.get('deps').sql, c.get('actor'), {
    sku: f.sku, name: f.name, description: f.description ?? '', kind: components.length > 1 ? 'bundle' : 'single', billing: f.billing, visibility: f.visibility,
    maxQuantity: Number(f.maxQuantity || 1), customerKind: f.customerKind, allowPromotionCodes: bool(f.allowPromotionCodes), automaticTax: bool(f.automaticTax), taxIdCollection: bool(f.taxIdCollection), components,
  });
  return back(c, `/admin/offers/${(o as unknown as { id: string }).id}`, 'Offer created as draft. Add a price, sync it to Stripe, then activate.');
}));

adminUi.get('/offers/:id', async (c) => {
  const o = (await catalogue.getOffer(c.get('deps').sql, c.req.param('id'))) as unknown as Record<string, unknown> & { id: string; sku: string; name: string; status: string; billing: string; kind: string; components: Record<string, unknown>[]; prices: Record<string, unknown>[]; stripeProduct: Record<string, unknown> | null };
  const w = can(c, 'prices:write');
  return render(c, {
    title: o.name,
    body: (
      <>
        <h1>{o.name} <code>{o.sku}</code> <Badge v={o.status} /></h1>
        <p class="muted">{o.kind} · {o.billing} · Stripe product: <code>{String(o.stripeProduct?.stripe_product_id ?? 'not synced')}</code> {o.stripeProduct ? <Badge v={String(o.stripeProduct.sync_state)} /> : null}</p>
        {can(c, 'products:write') ? (
          <div class="card">
            {['active', 'archived', 'draft'].filter((s) => s !== o.status).map((s) => (
              <form class="inline" method="post" action={`/admin/offers/${o.id}/status`}><Csrf token={c.get('csrf')} /><input type="hidden" name="status" value={s} /><button class={s === 'archived' ? 'danger' : ''} type="submit">{s === 'active' ? 'Activate (publish)' : s === 'archived' ? 'Archive' : 'Back to draft'}</button></form>
            ))}
            {can(c, 'stripe:sync') ? <form class="inline" method="post" action={`/admin/offers/${o.id}/sync`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Sync product to Stripe now</button></form> : null}
          </div>
        ) : null}
        <h2>Entitlement components</h2>
        <div class="table-wrap"><table><thead><tr><th>Product</th><th>Edition</th><th>Term</th><th>Seats/unit</th><th>Qty scales seats</th><th>Trial</th><th>Grace</th><th>Refund</th><th>Dispute</th></tr></thead><tbody>
          {o.components.map((x) => <tr><td>{String(x.product_slug)} v{String(x.major_version)} <span class="muted">({String(x.protocol_id)})</span></td><td>{String(x.edition_name)}</td><td>{String(x.term_type)}{x.term_interval ? ` ${x.term_interval_count} ${x.term_interval}` : ''}</td><td>{String(x.seats_per_unit ?? '—')}</td><td>{x.quantity_scales_seats ? 'yes' : 'no'}</td><td>{String(x.trial_days ?? '—')}</td><td>{String(x.grace_days)}</td><td>{String(x.refund_action)}</td><td>{String(x.dispute_action)}</td></tr>)}
        </tbody></table></div>
        <h2>Prices (immutable versions)</h2>
        <div class="table-wrap"><table><thead><tr><th>Version</th><th>Amount</th><th>Interval</th><th>Tax</th><th>Status</th><th>Stripe price</th><th>Sync</th><th></th></tr></thead><tbody>
          {o.prices.map((p) => <tr><td><code>{String(p.id)}</code></td><td>{money(Number(p.unit_amount), String(p.currency))}</td><td>{p.recurring_interval ? `${p.recurring_interval_count} ${p.recurring_interval}` : 'one-time'}</td><td>{String(p.tax_behavior)}</td><td><Badge v={String(p.status)} /></td>
            <td><code>{String(p.stripe_price_id ?? '—')}</code></td><td><Badge v={String(p.sync_state ?? 'pending')} />{p.sync_error ? <div class="muted">{String(p.sync_error)}</div> : null}</td>
            <td>{w && p.status === 'draft' ? <form class="inline" method="post" action={`/admin/prices/${p.id}/activate`}><Csrf token={c.get('csrf')} /><button type="submit">Activate</button></form> : null}
              {w && p.status !== 'archived' ? <form class="inline" method="post" action={`/admin/prices/${p.id}/archive`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Archive</button></form> : null}
              {can(c, 'stripe:sync') && ['failed', 'drifted', 'pending'].includes(String(p.sync_state)) ? ['retry', 'reactivate', 'recreate'].map((a) => <form class="inline" method="post" action={`/admin/prices/${p.id}/repair`}><Csrf token={c.get('csrf')} /><input type="hidden" name="action" value={a} /><button class="secondary" type="submit">{a}</button></form>) : null}</td></tr>)}
        </tbody></table></div>
        {w ? (
          <details class="card"><summary>New price version</summary><form method="post" action="/admin/prices"><Csrf token={c.get('csrf')} /><input type="hidden" name="offerId" value={o.id} />
            <div class="row"><div><label for="currency">Currency</label><input id="currency" name="currency" pattern="[A-Za-z]{3}" value="AUD" required /></div>
              <div><label for="unitAmount">Amount in minor units (e.g. cents)</label><input id="unitAmount" name="unitAmount" type="number" min="0" step="1" required /></div>
              {o.billing === 'recurring' ? <div><label for="ri">Interval</label><div class="row"><input id="ri" name="recurringIntervalCount" type="number" min="1" value="1" /><select name="recurringInterval"><option>month</option><option>year</option><option>week</option><option>day</option></select></div></div> : null}
              <div><label for="taxBehavior">Tax behaviour</label><select id="taxBehavior" name="taxBehavior"><option>unspecified</option><option>exclusive</option><option>inclusive</option></select></div></div>
            <p class="muted">Creates an immutable draft and queues creation of a matching Stripe Price. Existing purchases and subscriptions keep their historical prices.</p>
            <button type="submit">Create price version</button></form></details>
        ) : null}
      </>
    ),
  });
});

adminUi.post('/offers/:id/status', action(async (c, f) => {
  await catalogue.setOfferStatus(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.status as 'active');
  return back(c, `/admin/offers/${c.req.param('id')}`, `Offer ${f.status}`);
}));
adminUi.post('/offers/:id/sync', action(async (c) => {
  if (!c.get('actor').permissions?.has('stripe:sync')) throw new AppError('forbidden', 'Missing permission stripe:sync');
  await stripeSync.syncOffer(c.get('deps').sql, c.get('deps').stripe, c.req.param('id')!, c.get('actor'));
  return back(c, `/admin/offers/${c.req.param('id')}`, 'Stripe product synced');
}));
adminUi.post('/prices', action(async (c, f) => {
  const p = await catalogue.createPriceVersion(c.get('deps').sql, c.get('actor'), { offerId: f.offerId, currency: f.currency, unitAmount: Number(f.unitAmount), recurringInterval: strOrNull(f.recurringInterval), recurringIntervalCount: numOrNull(f.recurringIntervalCount), taxBehavior: f.taxBehavior });
  // Try to sync immediately for a responsive UI; the queued job covers failures.
  let note = 'Price created; Stripe sync queued.';
  if (can(c, 'stripe:sync')) {
    try {
      await stripeSync.syncPrice(c.get('deps').sql, c.get('deps').stripe, String(p.id), c.get('actor'));
      note = 'Price created and synced to Stripe. Activate it to make it sellable.';
    } catch (e) {
      note = `Price created; Stripe sync failed and will be retried: ${toAppError(e).message === 'Internal error' ? String((e as Error).message).slice(0, 200) : toAppError(e).message}`;
    }
  }
  return back(c, `/admin/offers/${f.offerId}`, note);
}));
adminUi.post('/prices/:id/activate', action(async (c) => {
  const p = await catalogue.activatePriceVersion(c.get('deps').sql, c.get('actor'), c.req.param('id')!);
  return back(c, `/admin/offers/${p.offer_id}`, 'Price activated');
}));
adminUi.post('/prices/:id/archive', action(async (c) => {
  const p = await catalogue.archivePriceVersion(c.get('deps').sql, c.get('actor'), c.req.param('id')!);
  return back(c, `/admin/offers/${p.offer_id}`, 'Price archived');
}));
adminUi.post('/prices/:id/repair', action(async (c, f) => {
  await stripeSync.repairPriceMapping(c.get('deps').sql, c.get('deps').stripe, c.get('actor'), c.req.param('id')!, f.action as 'retry');
  const p = await catalogue.getPriceVersion(c.get('deps').sql, c.req.param('id')!);
  return back(c, `/admin/offers/${p.offer_id}`, `Repair (${f.action}) completed`);
}));

// --------------------------------------------------------------------------------------------
// Customers
// --------------------------------------------------------------------------------------------

adminUi.get('/customers', async (c) => {
  const rows = await customers.listCustomers(c.get('deps').sql, { search: c.req.query('q'), limit: 100 });
  return render(c, {
    title: 'Customers',
    body: (
      <>
        <h1>Customers</h1>
        <form method="get" action="/admin/customers"><label for="q">Search (name, organisation, email, id)</label><input id="q" name="q" value={c.req.query('q') ?? ''} /><button type="submit">Search</button></form>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Kind</th><th>Billing email</th><th>Status</th><th>Entitlements</th><th>Created</th></tr></thead><tbody>
          {rows.map((r) => <tr><td><a href={`/admin/customers/${r.id}`}>{r.organisation_name ?? r.display_name}</a><br /><span class="mono muted">{r.id}</span></td><td>{r.kind}</td><td>{r.billing_email}</td><td><Badge v={r.status} /></td><td>{r.entitlements}</td><td>{fmt(r.created_at)}</td></tr>)}
        </tbody></table></div>
        {can(c, 'customers:write') ? (
          <details class="card"><summary>New customer</summary><form method="post" action="/admin/customers"><Csrf token={c.get('csrf')} />
            <div class="row"><div><label for="kind">Kind</label><select id="kind" name="kind"><option>organisation</option><option>individual</option></select></div>
              <div><label for="dn">Display name</label><input id="dn" name="displayName" required /></div><div><label for="on">Organisation name</label><input id="on" name="organisationName" /></div>
              <div><label for="be">Billing email</label><input id="be" name="billingEmail" type="email" required /></div></div>
            <button type="submit">Create</button></form></details>
        ) : null}
      </>
    ),
  });
});

adminUi.post('/customers', action(async (c, f) => {
  const r = await customers.createCustomer(c.get('deps').sql, c.get('actor'), { kind: f.kind, displayName: f.displayName, organisationName: strOrNull(f.organisationName), billingEmail: f.billingEmail });
  return back(c, `/admin/customers/${r.id}`, 'Customer created');
}));

adminUi.get('/customers/:id', async (c) => {
  const sql = c.get('deps').sql;
  const cu = await customers.getCustomer(sql, c.req.param('id'));
  const ents = await customers.listCustomerEntitlements(sql, cu.id);
  const offers = await sql<{ sku: string; name: string; status: string }[]>`SELECT sku, name, status FROM offers WHERE status <> 'archived' ORDER BY name`;
  const purchases = await sql<{ id: string; source: string; currency: string; amount_total: number; status: string; created_at: Date }[]>`SELECT id, source, currency, amount_total, status, created_at FROM purchases WHERE customer_id = ${cu.id} ORDER BY created_at DESC`;
  return render(c, {
    title: cu.display_name,
    body: (
      <>
        <h1>{cu.organisation_name ?? cu.display_name} <Badge v={cu.status} /></h1>
        <p class="muted"><code>{cu.id}</code> · {cu.kind} · {cu.billing_email} · Stripe <code>{cu.stripe_customer_id ?? '—'}</code></p>
        <h2>Entitlements</h2>
        <div class="table-wrap"><table><thead><tr><th>Licence</th><th>Product</th><th>Edition</th><th>Term</th><th>Expires</th><th>Seats</th><th>Devices</th><th>Status</th></tr></thead><tbody>
          {ents.map((e) => <tr><td><a href={`/admin/licenses/${e.license_id}`}><code>{e.license_id}</code></a></td><td>{e.product_name} v{e.major_version}</td><td>{e.edition_name}</td><td>{e.term_type}</td><td>{e.expires_at ? fmt(e.expires_at) : 'perpetual'}</td><td>{e.seats ?? '—'}</td><td>{e.activation_model === 'device_seats' ? e.active_activations : '—'}</td><td><Badge v={e.status} />{e.review_required ? <Badge v="review" /> : null}</td></tr>)}
        </tbody></table></div>
        {can(c, 'entitlements:issue') ? (
          <details class="card"><summary>Grant entitlement from an offer</summary><form method="post" action={`/admin/customers/${cu.id}/grant`}><Csrf token={c.get('csrf')} />
            <div class="row"><div><label for="sku">Offer</label><select id="sku" name="offerSku">{offers.map((o) => <option value={o.sku}>{o.name} ({o.sku}, {o.status})</option>)}</select></div>
              <div><label for="qty">Quantity</label><input id="qty" name="quantity" type="number" min="1" value="1" /></div>
              <div><label for="exp">Expires (subscription/fixed terms)</label><input id="exp" name="expiresAt" type="datetime-local" /></div></div>
            <label for="reason">Reason (audited)</label><input id="reason" name="reason" required minlength={3} />
            <button type="submit">Grant</button></form></details>
        ) : null}
        <h2>Members</h2>
        <div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Verified</th><th></th></tr></thead><tbody>
          {cu.members.map((m) => <tr><td>{m.email}</td><td>{m.role}</td><td>{fmt(m.email_verified_at)}</td><td>{can(c, 'customers:write') ? <form class="inline" method="post" action={`/admin/customers/${cu.id}/members/${m.portal_user_id}/remove`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Remove</button></form> : null}</td></tr>)}
        </tbody></table></div>
        {can(c, 'customers:write') ? <form method="post" action={`/admin/customers/${cu.id}/members`} class="card"><Csrf token={c.get('csrf')} /><div class="row"><div><label for="me">Add member email</label><input id="me" name="email" type="email" required /></div><div><label for="mr">Role</label><select id="mr" name="role"><option>member</option><option>admin</option><option>billing</option></select></div></div><button type="submit">Add member</button></form> : null}
        <h2>Purchases</h2>
        <div class="table-wrap"><table><thead><tr><th>Purchase</th><th>Source</th><th>Total</th><th>Status</th><th>When</th></tr></thead><tbody>
          {purchases.map((p) => <tr><td><code>{p.id}</code></td><td>{p.source}</td><td>{p.source === 'admin_grant' ? '—' : money(p.amount_total, p.currency)}</td><td><Badge v={p.status} /></td><td>{fmt(p.created_at)}</td></tr>)}
        </tbody></table></div>
      </>
    ),
  });
});

adminUi.post('/customers/:id/grant', action(async (c, f) => {
  const { sql, config } = c.get('deps');
  const r = await grantEntitlements(sql, config, c.get('actor'), { customerId: c.req.param('id'), offerSku: f.offerSku, quantity: Number(f.quantity || 1), expiresAt: strOrNull(f.expiresAt) ? new Date(f.expiresAt + 'Z') : null, reason: f.reason });
  return render(c, {
    title: 'Entitlements granted',
    body: (
      <div class="card"><h1>Entitlements granted</h1><p>Activation keys are shown <b>once</b>. Deliver them through a secure channel; they can be rotated later but not recovered.</p>
        <table><thead><tr><th>Licence</th><th>Activation key</th></tr></thead><tbody>{r.entitlements.map((e) => <tr><td><a href={`/admin/licenses/${e.licenseId}`}><code>{e.licenseId}</code></a></td><td><code class="secret">{e.activationKey}</code></td></tr>)}</tbody></table>
        <p><a href={`/admin/customers/${c.req.param('id')}`}>Back to customer</a></p></div>
    ),
  });
}));
adminUi.post('/customers/:id/members', action(async (c, f) => {
  await customers.addMember(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.email ?? '', f.role as 'member', c.get('deps').config);
  return back(c, `/admin/customers/${c.req.param('id')}`, 'Member added');
}));
adminUi.post('/customers/:id/members/:userId/remove', action(async (c) => {
  await customers.removeMember(c.get('deps').sql, c.get('actor'), c.req.param('id')!, c.req.param('userId')!);
  return back(c, `/admin/customers/${c.req.param('id')}`, 'Member removed');
}));

// --------------------------------------------------------------------------------------------
// Licences
// --------------------------------------------------------------------------------------------

adminUi.get('/licenses', async (c) => {
  const rows = await searchLicenses(c.get('deps').sql, { q: c.req.query('q'), status: c.req.query('status') || undefined, limit: 100 });
  return render(c, {
    title: 'Licences',
    body: (
      <>
        <h1>Licences</h1>
        <form method="get" action="/admin/licenses" class="row"><div><label for="q">Licence, entitlement, customer id, email or name</label><input id="q" name="q" value={c.req.query('q') ?? ''} /></div>
          <div><label for="st">Status</label><select id="st" name="status"><option value="">any</option><option>active</option><option>revoked</option></select></div><div><button type="submit">Search</button></div></form>
        <div class="table-wrap"><table><thead><tr><th>Licence</th><th>Customer</th><th>Product</th><th>Edition</th><th>Term</th><th>Expires</th><th>Status</th></tr></thead><tbody>
          {rows.map((r) => <tr><td><a href={`/admin/licenses/${r.license_id}`}><code>{r.license_id}</code></a></td><td><a href={`/admin/customers/${r.customer_id}`}>{r.customer_name}</a></td><td>{r.product_slug} v{r.major_version}</td><td>{r.edition}</td><td>{r.term_type}</td><td>{r.expires_at ? fmt(r.expires_at) : 'perpetual'}</td><td><Badge v={r.status} /></td></tr>)}
        </tbody></table></div>
      </>
    ),
  });
});

interface LicenceView {
  license_id: string; status: string; review_required: boolean; review_reason: string | null; customer_id: string; customer_display_name: string;
  product_name: string; major_version: number; edition_name: string; term_type: string; expires_at: Date | null; seats: number | null;
  current_issued_at: Date | null; current_key_ids: string[]; activationKeyHint: string | null; revoked_reason: string | null; revoked_at: Date | null;
  activation_model: string; organisation_name: string | null; snapshot: unknown;
  activations: Array<{ id: string; device_suffix: string; status: string; activated_at: Date; last_validated_at: Date | null; deactivated_at: Date | null; deactivated_by: string | null; counted_as_transfer: boolean }>;
  issuances: Array<{ issued_at: Date; artifact: string; activation_id: string | null; key_ids: string[]; reason: string; actor: string }>;
}

adminUi.get('/licenses/:id', async (c) => {
  const sql = c.get('deps').sql;
  const l = (await getLicenseDetail(sql, c.req.param('id'))) as unknown as LicenceView;
  const t = l.activation_model === 'device_seats' ? await licensing.transferStatus(sql, l.license_id) : null;
  const id = l.license_id;
  const F = ({ path, children }: { path: string; children?: Child }) => <form method="post" action={`/admin/licenses/${id}/${path}`} class="card"><Csrf token={c.get('csrf')} />{children}</form>;
  return render(c, {
    title: id,
    body: (
      <>
        <h1><code>{id}</code> <Badge v={l.status} />{l.review_required ? <> <Badge v="review" /> <span class="muted">{l.review_reason}</span></> : null}</h1>
        <div class="card"><div class="grid">
          <div><span class="muted">Customer</span><br /><a href={`/admin/customers/${l.customer_id}`}>{l.customer_display_name}</a></div>
          <div><span class="muted">Product</span><br />{l.product_name} v{l.major_version} · {l.edition_name}</div>
          <div><span class="muted">Term</span><br />{l.term_type} · {l.expires_at ? `until ${fmt(l.expires_at)}` : 'perpetual'}</div>
          <div><span class="muted">Seats</span><br />{l.seats ?? '—'}</div>
          <div><span class="muted">Last issued</span><br />{fmt(l.current_issued_at)} ({l.current_key_ids.join(', ')})</div>
          <div><span class="muted">Activation key</span><br />…{l.activationKeyHint ?? '—'}</div>
        </div>{l.revoked_reason ? <p>Revoked: {l.revoked_reason} ({fmt(l.revoked_at)})</p> : null}
          <p><a class="button secondary" href={`/admin/licenses/${id}/file`}>Download licence file</a></p>
          <p class="muted">Revocation affects future server interactions (activate/renew); installations that stay offline keep working until they next contact the server.</p></div>
        {l.activation_model === 'device_seats' ? (
          <>
            <h2>Devices</h2>
            <p>Transfers in the last 365 days: {t!.used} used, {t!.granted} granted, {t!.remaining} of {t!.allowance} remaining.</p>
            <div class="table-wrap"><table><thead><tr><th>Activation</th><th>Device</th><th>Status</th><th>Activated</th><th>Last validated</th><th>Released</th><th></th></tr></thead><tbody>
              {l.activations.map((a) => <tr><td><code>{a.id}</code>{a.counted_as_transfer ? <span class="muted"> (transfer)</span> : null}</td><td>…{a.device_suffix}</td><td><Badge v={a.status} /></td><td>{fmt(a.activated_at)}</td><td>{fmt(a.last_validated_at)}</td><td>{a.deactivated_at ? `${fmt(a.deactivated_at)} by ${a.deactivated_by}` : ''}</td>
                <td>{a.status === 'active' && can(c, 'activations:release') ? <form class="inline" method="post" action={`/admin/activations/${a.id}/release`}><Csrf token={c.get('csrf')} /><input type="hidden" name="licenseId" value={id} /><button class="secondary" type="submit">Release</button></form> : null}</td></tr>)}
            </tbody></table></div>
            {can(c, 'transfers:write') ? <div class="row">
              <F path="transfers/grant"><label for="amt">Grant extra transfers</label><input id="amt" name="amount" type="number" min="1" max="100" value="1" /><label for="gr">Reason</label><input id="gr" name="reason" required /><button type="submit">Grant</button></F>
              <F path="transfers/reset"><label for="rr">Reset transfer window — reason</label><input id="rr" name="reason" required /><button type="submit">Reset</button></F>
            </div> : null}
            {can(c, 'entitlements:issue') ? <F path="amend"><label for="seats">Change seats (audited amendment)</label><input id="seats" name="seats" type="number" min="1" value={String(l.seats ?? 1)} /><label for="ar">Reason</label><input id="ar" name="reason" required /><button type="submit">Amend</button></F> : null}
          </>
        ) : <p class="muted">This edition does not track devices.</p>}
        <h2>Actions</h2>
        <div class="row">
          {can(c, 'licenses:issue') ? <F path="reissue"><label for="org">Organisation name (blank keeps)</label><input id="org" name="organisationName" value={l.organisation_name ?? ''} /><label for="rir">Reason</label><input id="rir" name="reason" required /><button type="submit">Re-issue (same licence id)</button></F> : null}
          {can(c, 'licenses:issue') ? <F path="rotate-key"><p>Rotate the activation key. The old key stops working; activations are unaffected. The new key is shown once.</p><button type="submit">Rotate activation key</button></F> : null}
          {can(c, 'entitlements:revoke') ? (l.status === 'revoked'
            ? <F path="unrevoke"><label for="ur">Reverse revocation — reason</label><input id="ur" name="reason" required /><label for="uc">Type the licence id to confirm</label><input id="uc" name="confirm" required /><button type="submit">Un-revoke</button></F>
            : <F path="revoke"><label for="rv">Revoke — reason</label><input id="rv" name="reason" required /><label for="rc">Type the licence id to confirm</label><input id="rc" name="confirm" required /><button class="danger" type="submit">Revoke</button></F>) : null}
        </div>
        <h2>Issuance history</h2>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Artifact</th><th>Keys</th><th>Reason</th><th>Actor</th></tr></thead><tbody>
          {l.issuances.map((i) => <tr><td>{fmt(i.issued_at)}</td><td>{i.artifact}{i.activation_id ? ` ${i.activation_id}` : ''}</td><td>{i.key_ids.join(', ')}</td><td>{i.reason}</td><td>{i.actor}</td></tr>)}
        </tbody></table></div>
        <h2>Policy snapshot</h2><details><summary>Show effective policy frozen at purchase</summary><code>{JSON.stringify(l.snapshot)}</code></details>
      </>
    ),
  });
});

adminUi.get('/licenses/:id/file', async (c) => {
  if (!can(c, 'licenses:read')) return c.text('Forbidden', 403);
  try {
    const f = await licensing.licenseFileForDownload(c.get('deps').sql, c.get('deps').config, c.get('actor'), c.req.param('id'));
    c.header('Content-Disposition', `attachment; filename="${f.fileName}"`);
    return c.json(f.envelope);
  } catch (e) {
    return back(c, `/admin/licenses/${c.req.param('id')}`, toAppError(e).message, 'err');
  }
});

const confirmed = (f: Record<string, string>, id: string) => {
  if (f.confirm?.trim() !== id) throw new AppError('precondition_failed', 'Confirmation text did not match the licence id');
};
adminUi.post('/licenses/:id/revoke', action(async (c, f) => {
  confirmed(f, c.req.param('id')!);
  await licensing.revokeEntitlement(c.get('deps').sql, c.get('actor'), c.req.param('id')!, { reason: f.reason ?? '' });
  return back(c, `/admin/licenses/${c.req.param('id')}`, 'Revoked');
}));
adminUi.post('/licenses/:id/unrevoke', action(async (c, f) => {
  confirmed(f, c.req.param('id')!);
  await licensing.unrevokeEntitlement(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.reason ?? '');
  return back(c, `/admin/licenses/${c.req.param('id')}`, 'Revocation reversed');
}));
adminUi.post('/licenses/:id/reissue', action(async (c, f) => {
  await licensing.reissueLicense(c.get('deps').sql, c.get('deps').config, c.get('actor'), c.req.param('id')!, { reason: f.reason ?? '', organisationName: strOrNull(f.organisationName) ?? undefined });
  return back(c, `/admin/licenses/${c.req.param('id')}`, 'Re-issued with the same licence id');
}));
adminUi.post('/licenses/:id/amend', action(async (c, f) => {
  await licensing.amendEntitlement(c.get('deps').sql, c.get('actor'), c.req.param('id')!, { seats: Number(f.seats), reason: f.reason ?? '' });
  return back(c, `/admin/licenses/${c.req.param('id')}`, 'Entitlement amended');
}));
adminUi.post('/licenses/:id/transfers/grant', action(async (c, f) => {
  await licensing.grantTransfers(c.get('deps').sql, c.get('actor'), c.req.param('id')!, Number(f.amount), f.reason ?? '');
  return back(c, `/admin/licenses/${c.req.param('id')}`, 'Transfers granted');
}));
adminUi.post('/licenses/:id/transfers/reset', action(async (c, f) => {
  await licensing.resetTransfers(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.reason ?? '');
  return back(c, `/admin/licenses/${c.req.param('id')}`, 'Transfer window reset');
}));
adminUi.post('/licenses/:id/rotate-key', action(async (c) => {
  const r = await licensing.rotateActivationKey(c.get('deps').sql, c.get('deps').config, c.get('actor'), c.req.param('id')!);
  return render(c, { title: 'New activation key', body: <div class="card"><h1>New activation key</h1><p>Shown once. The previous key no longer works.</p><code class="secret">{r.activationKey}</code><p><a href={`/admin/licenses/${r.licenseId}`}>Back to licence</a></p></div> });
}));
adminUi.post('/activations/:id/release', action(async (c, f) => {
  await licensing.releaseActivation(c.get('deps').sql, c.get('actor'), c.req.param('id')!, 'support', c.get('deps').config);
  return back(c, `/admin/licenses/${f.licenseId}`, 'Device released (an offline device learns this on its next renew)');
}));

// --------------------------------------------------------------------------------------------
// Signing keys
// --------------------------------------------------------------------------------------------

adminUi.get('/keys', async (c) => {
  const sql = c.get('deps').sql;
  const list = await keys.listSigningKeys(sql);
  const compat = await keys.listCompatibilities(sql);
  const majors = await sql<{ id: string; label: string }[]>`SELECT m.id, p.slug || ' v' || m.major_version AS label FROM product_majors m JOIN products p ON p.id = m.product_id ORDER BY 2`;
  const m = can(c, 'signing_keys:manage');
  return render(c, {
    title: 'Signing keys',
    body: (
      <>
        <h1>Signing keys</h1>
        <p class="muted">Private keys are AES-256-GCM encrypted in PostgreSQL under SIGNING_KEK_V{c.get('deps').config.signingKeks.activeVersion} (Workers Secret) and are never displayed or exported here. They are decrypted only inside the Worker to sign — this is application-level encryption, not an HSM.</p>
        <div class="table-wrap"><table><thead><tr><th>Key id</th><th>Algorithm</th><th>Status</th><th>Origin</th><th>KEK</th><th>Public key (base64url)</th><th>Created</th><th></th></tr></thead><tbody>
          {list.map((k) => <tr><td><code>{k.keyId}</code></td><td>{k.algorithm}</td><td><Badge v={k.status} /></td><td>{k.origin}</td><td>v{k.kekVersion}</td><td><details><summary>show</summary><code>{k.publicKey}</code></details></td><td>{fmt(k.createdAt)}</td>
            <td>{m && k.status === 'generated' ? <form class="inline" method="post" action={`/admin/keys/${k.keyId}/publish`}><Csrf token={c.get('csrf')} /><button type="submit">Publish</button></form> : null}
              {m && (k.status === 'published' || k.status === 'generated') ? <details><summary>Retire / compromise</summary><form method="post" action={`/admin/keys/${k.keyId}/retire`}><Csrf token={c.get('csrf')} /><label>Reason</label><input name="reason" required /><label>Type key id to confirm</label><input name="confirm" required /><label><input type="checkbox" name="force" /> Force even if a product is left without eligible keys</label><label><input type="checkbox" name="compromised" /> Mark COMPROMISED</label><button class="danger" type="submit">Apply</button></form></details> : null}</td></tr>)}
        </tbody></table></div>
        <h2>Trust and eligibility per product major</h2>
        <KeyCompatTable rows={compat} />
        {m ? (
          <div class="row">
            <form method="post" action="/admin/keys" class="card"><Csrf token={c.get('csrf')} /><h2>Generate keypair</h2>
              <label for="alg">Algorithm</label><select id="alg" name="algorithm">{ALGORITHMS.map((a) => <option>{a}</option>)}</select>
              <label for="kid">Key id (blank = repass-&lt;alg&gt;-&lt;year&gt;)</label><input id="kid" name="keyId" pattern="[A-Za-z0-9_.-]{1,128}" />
              <p class="muted">Generating changes nothing until the key is published, trusted by a shipped minimum release, and marked eligible.</p><button type="submit">Generate</button></form>
            <form method="post" action="/admin/keys/trust" class="card"><Csrf token={c.get('csrf')} /><h2>Record trust</h2>
              <label>Key</label><select name="keyId">{list.map((k) => <option>{k.keyId}</option>)}</select>
              <label>Product major</label><select name="productMajorId">{majors.map((x) => <option value={x.id}>{x.label}</option>)}</select>
              <label>First release embedding the key</label><input name="trustedSinceVersion" required placeholder="2.1.0" /><label>Last release embedding it (optional)</label><input name="trustedUntilVersion" />
              <button type="submit">Save trust</button></form>
            <form method="post" action="/admin/keys/eligibility" class="card"><Csrf token={c.get('csrf')} /><h2>Eligibility</h2>
              <label>Key</label><select name="keyId">{list.map((k) => <option>{k.keyId}</option>)}</select>
              <label>Product major</label><select name="productMajorId">{majors.map((x) => <option value={x.id}>{x.label}</option>)}</select>
              <label><input type="checkbox" name="eligible" checked /> Eligible for issuance</label><button type="submit">Apply</button></form>
          </div>
        ) : null}
        <p><a href="/admin/keys/export">Download trusted public keys (JSON)</a></p>
      </>
    ),
  });
});

adminUi.post('/keys', action(async (c, f) => {
  if (!isSignatureAlgorithm(f.algorithm)) throw new AppError('validation_failed', 'Unknown algorithm');
  const k = await keys.generateSigningKey(c.get('deps').sql, c.get('deps').config.signingKeks, (requireManage(c), c.get('actor')), { algorithm: f.algorithm, keyId: strOrNull(f.keyId) ?? undefined });
  return back(c, '/admin/keys', `Generated ${k.keyId}`);
}));
function requireManage(c: Ctx) {
  const a = c.get('actor') as Actor;
  if (!a.permissions?.has('signing_keys:manage')) throw new AppError('forbidden', 'Missing permission signing_keys:manage');
  if (!a.mfaAt || Date.now() - a.mfaAt.getTime() > 15 * 60_000) throw new AppError('forbidden', 'This action requires re-authentication with your authenticator code (step-up)');
}
adminUi.post('/keys/:id/publish', action(async (c) => (requireManage(c), await keys.publishSigningKey(c.get('deps').sql, c.get('actor'), c.req.param('id')!), back(c, '/admin/keys', 'Published'))));
adminUi.post('/keys/trust', action(async (c, f) => {
  requireManage(c);
  await keys.setKeyTrust(c.get('deps').sql, c.get('actor'), { keyId: f.keyId!, productMajorId: f.productMajorId!, trustedSinceVersion: f.trustedSinceVersion!, trustedUntilVersion: strOrNull(f.trustedUntilVersion) });
  return back(c, '/admin/keys', 'Trust recorded');
}));
adminUi.post('/keys/eligibility', action(async (c, f) => {
  requireManage(c);
  await keys.setKeyEligibility(c.get('deps').sql, c.get('actor'), { keyId: f.keyId!, productMajorId: f.productMajorId!, eligible: bool(f.eligible) });
  return back(c, '/admin/keys', 'Eligibility updated');
}));
adminUi.post('/keys/:id/retire', action(async (c, f) => {
  requireManage(c);
  if (f.confirm?.trim() !== c.req.param('id')) throw new AppError('precondition_failed', 'Confirmation text did not match the key id');
  await keys.retireSigningKey(c.get('deps').sql, c.get('actor'), c.req.param('id')!, { reason: f.reason ?? '', force: bool(f.force), compromised: bool(f.compromised) });
  return back(c, '/admin/keys', bool(f.compromised) ? 'Marked compromised' : 'Retired');
}));
adminUi.get('/keys/export', async (c) => {
  if (!can(c, 'signing_keys:read_public')) return c.text('Forbidden', 403);
  c.header('Content-Disposition', 'attachment; filename="repass-trusted-public-keys.json"');
  return c.json({ generatedAt: new Date().toISOString(), keys: await keys.exportTrustedKeys(c.get('deps').sql) });
});

// --------------------------------------------------------------------------------------------
// Billing: checkouts, Stripe events, mappings, jobs
// --------------------------------------------------------------------------------------------

adminUi.get('/billing', async (c) => {
  const sql = c.get('deps').sql;
  const [checkouts, events, jobs, mappings] = await Promise.all([
    listCheckouts(sql, { limit: 30 }), billing.listStripeEvents(sql, { limit: 30, status: c.req.query('events') || undefined }),
    listJobs(sql, { limit: 30, status: c.req.query('jobs') || undefined }), stripeSync.listMappings(sql),
  ]);
  const rec = can(c, 'webhooks:reconcile');
  return render(c, {
    title: 'Billing',
    body: (
      <>
        <h1>Billing and integrations</h1>
        {rec ? <div class="card"><form class="inline" method="post" action="/admin/billing/reconcile"><Csrf token={c.get('csrf')} /><input type="hidden" name="kind" value="checkouts" /><button type="submit">Reconcile open checkouts</button></form>
          <form class="inline" method="post" action="/admin/billing/reconcile"><Csrf token={c.get('csrf')} /><input type="hidden" name="kind" value="subscriptions" /><button type="submit">Reconcile subscriptions</button></form>
          <form class="inline" method="post" action="/admin/billing/reconcile"><Csrf token={c.get('csrf')} /><input type="hidden" name="kind" value="backfill" /><button class="secondary" type="submit">Backfill Stripe events (3 days)</button></form>
          {can(c, 'stripe:sync') ? <form class="inline" method="post" action="/admin/billing/drift"><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Check Stripe drift</button></form> : null}</div> : null}
        <h2>Stripe price mappings</h2>
        <div class="table-wrap"><table><thead><tr><th>SKU</th><th>Price version</th><th>Amount</th><th>Status</th><th>Stripe price</th><th>Sync</th><th>Drift / error</th></tr></thead><tbody>
          {mappings.map((m) => <tr><td>{String(m.sku)}</td><td><code>{String(m.price_version_id)}</code></td><td>{money(Number(m.unit_amount), String(m.currency))}{m.recurring_interval ? `/${m.recurring_interval}` : ''}</td><td><Badge v={String(m.price_status)} /></td><td><code>{String(m.stripe_price_id ?? '—')}</code></td><td><Badge v={String(m.sync_state)} /></td><td class="muted">{m.drift_detail ? JSON.stringify(m.drift_detail) : String(m.last_error ?? '')}</td></tr>)}
        </tbody></table></div>
        <h2>Checkouts</h2>
        <div class="table-wrap"><table><thead><tr><th>Checkout</th><th>SKU</th><th>Email</th><th>Expected</th><th>Status</th><th>Created</th><th>Note</th></tr></thead><tbody>
          {checkouts.map((x) => <tr><td><code>{x.id}</code></td><td>{x.sku}</td><td>{x.email}</td><td>{money(x.expected_subtotal, x.currency)}</td><td><Badge v={x.status} /></td><td>{fmt(x.created_at)}</td><td class="muted">{x.failure_reason ?? ''}</td></tr>)}
        </tbody></table></div>
        <h2>Stripe events <a href="/admin/billing?events=failed">failed</a> · <a href="/admin/billing?events=dead">dead</a> · <a href="/admin/billing">all</a></h2>
        <div class="table-wrap"><table><thead><tr><th>Event</th><th>Type</th><th>Status</th><th>Attempts</th><th>Outcome / error</th><th>Received</th><th></th></tr></thead><tbody>
          {events.map((e) => <tr><td><code>{e.id}</code></td><td>{e.type}</td><td><Badge v={e.status} /></td><td>{e.attempts}</td><td class="muted">{e.outcome ?? e.last_error ?? ''}</td><td>{fmt(e.received_at)}</td>
            <td>{rec && e.status !== 'ignored' ? <form class="inline" method="post" action={`/admin/billing/events/${e.id}/replay`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Replay</button></form> : null}</td></tr>)}
        </tbody></table></div>
        <h2>Jobs <a href="/admin/billing?jobs=dead">dead</a> · <a href="/admin/billing?jobs=pending">pending</a></h2>
        <div class="table-wrap"><table><thead><tr><th>Id</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Next run</th><th>Error</th><th></th></tr></thead><tbody>
          {jobs.map((j) => <tr><td>{j.id}</td><td>{j.kind}</td><td><Badge v={j.status} /></td><td>{j.attempts}/{j.max_attempts}</td><td>{fmt(j.run_after)}</td><td class="muted">{j.last_error ?? ''}</td>
            <td>{rec && j.status === 'dead' ? <form class="inline" method="post" action={`/admin/billing/jobs/${j.id}/retry`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Retry</button></form> : null}</td></tr>)}
        </tbody></table></div>
      </>
    ),
  });
});

adminUi.post('/billing/reconcile', action(async (c, f) => {
  const a = c.get('actor');
  if (!a.permissions?.has('webhooks:reconcile')) throw new AppError('forbidden', 'Missing permission webhooks:reconcile');
  const { sql, config, stripe } = c.get('deps');
  let msg: string;
  if (f.kind === 'checkouts') msg = (await billing.reconcileCheckouts(sql, config, stripe, 10)).join(' | ') || 'Nothing to reconcile';
  else if (f.kind === 'subscriptions') msg = (await billing.reconcileSubscriptions(sql, config, stripe, 10)).join(' | ') || 'No live subscriptions';
  else msg = JSON.stringify(await billing.backfillEvents(sql, stripe, a, Math.floor(Date.now() / 1000) - 3 * 86400));
  return back(c, '/admin/billing', msg.slice(0, 280));
}));
adminUi.post('/billing/drift', action(async (c) => {
  if (!can(c, 'stripe:sync')) throw new AppError('forbidden', 'Missing permission stripe:sync');
  const r = await stripeSync.checkDrift(c.get('deps').sql, c.get('deps').stripe, 20);
  return back(c, '/admin/billing', `Checked ${r.checked} mapping(s); ${r.drifted} drifted`);
}));
adminUi.post('/billing/events/:id/replay', action(async (c) => (await billing.replayStripeEvent(c.get('deps').sql, c.get('actor'), c.req.param('id')!), back(c, '/admin/billing', 'Event queued for replay'))));
adminUi.post('/billing/jobs/:id/retry', action(async (c) => {
  if (!can(c, 'webhooks:reconcile')) throw new AppError('forbidden', 'Missing permission webhooks:reconcile');
  await retryDeadJob(c.get('deps').sql, Number(c.req.param('id')));
  return back(c, '/admin/billing', 'Job re-queued');
}));

// --------------------------------------------------------------------------------------------
// Email
// --------------------------------------------------------------------------------------------

adminUi.get('/email', async (c) => {
  const sql = c.get('deps').sql;
  const [rows, templates] = await Promise.all([email.listEmails(sql, { status: c.req.query('status') || undefined, limit: 100 }), email.listTemplates(sql)]);
  return render(c, {
    title: 'Email',
    body: (
      <>
        <h1>Transactional email (MailerSend)</h1>
        <p class="muted">Transport: <b>{c.get('deps').config.mailTransport}</b>. {c.get('deps').config.has('MAILERSEND_WEBHOOK_SECRET') ? 'Delivery webhooks configured: delivered/bounced states are tracked.' : 'Delivery webhooks are NOT configured: "sent" means accepted by MailerSend, not delivered.'}</p>
        <p><a href="/admin/email?status=dead">dead</a> · <a href="/admin/email?status=uncertain">uncertain</a> · <a href="/admin/email?status=failed">failed</a> · <a href="/admin/email">all</a></p>
        <div class="table-wrap"><table><thead><tr><th>Email</th><th>Template</th><th>Status</th><th>Attempts</th><th>Provider id</th><th>Error</th><th>Created</th><th></th></tr></thead><tbody>
          {rows.map((r) => <tr><td><code>{r.id}</code><br /><span class="muted">{r.business_key}</span></td><td>{r.template_key}</td><td><Badge v={r.status} /></td><td>{r.attempts}</td><td><code>{r.provider_message_id ?? '—'}</code></td><td class="muted">{r.last_error ?? ''}</td><td>{fmt(r.created_at)}</td>
            <td>{can(c, 'email:retry') && ['dead', 'failed', 'uncertain'].includes(r.status) ? <form class="inline" method="post" action={`/admin/email/${r.id}/retry`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Retry</button></form> : null}
              {can(c, 'email:retry') && r.status === 'uncertain' ? <><form class="inline" method="post" action={`/admin/email/${r.id}/resolve`}><Csrf token={c.get('csrf')} /><input type="hidden" name="outcome" value="sent" /><button class="secondary" type="submit">Mark sent</button></form><form class="inline" method="post" action={`/admin/email/${r.id}/resolve`}><Csrf token={c.get('csrf')} /><input type="hidden" name="outcome" value="dead" /><button class="secondary" type="submit">Mark not sent</button></form></> : null}</td></tr>)}
        </tbody></table></div>
        <h2>Templates</h2>
        {templates.map((t) => (
          <details class="card"><summary>{t.template_key} ({t.locale}, {t.category}) <Badge v={t.status} /></summary>
            {can(c, 'email:templates') ? (
              <form method="post" action={`/admin/email/templates/${t.id}`}><Csrf token={c.get('csrf')} />
                <label>Subject</label><input name="subject" value={t.subject} /><label>HTML ({'{{var}}'} escaped, {'{{{var}}}'} server-built HTML)</label><textarea name="htmlBody">{t.html_body}</textarea>
                <label>Text</label><textarea name="textBody">{t.text_body}</textarea><label>MailerSend template id (optional; overrides the bodies above)</label><input name="mailersendTemplateId" value={t.mailersend_template_id ?? ''} />
                <label>Status</label><select name="status"><option selected={t.status === 'active'}>active</option><option selected={t.status === 'disabled'}>disabled</option></select><button type="submit">Save template</button></form>
            ) : <code>{t.subject}</code>}
          </details>
        ))}
      </>
    ),
  });
});
adminUi.post('/email/:id/retry', action(async (c) => (await email.retryEmail(c.get('deps').sql, c.get('actor'), c.req.param('id')!), back(c, '/admin/email', 'Queued for retry'))));
adminUi.post('/email/:id/resolve', action(async (c, f) => (await email.markEmailResolved(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.outcome as 'sent'), back(c, '/admin/email', 'Resolved'))));
adminUi.post('/email/templates/:id', action(async (c, f) => {
  await email.updateTemplate(c.get('deps').sql, c.get('actor'), c.req.param('id')!, { subject: f.subject, htmlBody: f.htmlBody, textBody: f.textBody, mailersendTemplateId: strOrNull(f.mailersendTemplateId), status: f.status as 'active' });
  return back(c, '/admin/email', 'Template saved');
}));

// --------------------------------------------------------------------------------------------
// Access: administrators, roles, service accounts, API tokens
// --------------------------------------------------------------------------------------------

adminUi.get('/access', async (c) => {
  const sql = c.get('deps').sql;
  const a = c.get('actor');
  const manage = can(c, 'admins:manage');
  const [adminRows, roles, svcs, tokens] = await Promise.all([manage ? admins.listAdmins(sql) : [], admins.listRoles(sql), manage ? admins.listServiceAccounts(sql) : [], admins.listApiTokens(sql, a)]);
  const myScopes = ALL_PERMISSIONS.filter((p) => a.permissions?.has(p));
  return render(c, {
    title: 'Access',
    body: (
      <>
        <h1>Access</h1>
        <h2>API tokens</h2>
        <p class="muted">Bearer tokens for the terminal/automation admin API. Secrets are shown once and stored only as HMAC digests. High-risk scopes are limited to 30 days. See docs/runbooks/terminal-admin-api.md for the macOS Keychain workflow.</p>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Owner</th><th>Scopes</th><th>Expires</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>
          {tokens.map((t) => <tr><td>{t.name}<br /><code class="muted">rpl_…_{t.lookup_id}</code></td><td><code>{t.admin_user_id ?? t.service_account_id}</code></td><td>{t.scopes.join(', ')}</td><td>{fmt(t.expires_at)}</td><td>{fmt(t.last_used_at)}</td><td>{t.revoked_at ? <Badge v="revoked" /> : new Date(t.expires_at) < new Date() ? <Badge v="expired" /> : <Badge v="active" />}</td>
            <td>{!t.revoked_at ? <form class="inline" method="post" action={`/admin/access/tokens/${t.id}/revoke`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Revoke</button></form> : null}
              {!t.revoked_at && (t.service_account_id ? can(c, 'tokens:manage') : true) ? <form class="inline" method="post" action={`/admin/access/tokens/${t.id}/rotate`}><Csrf token={c.get('csrf')} /><button class="secondary" type="submit">Rotate</button></form> : null}</td></tr>)}
        </tbody></table></div>
        <details class="card"><summary>Create an API token</summary><form method="post" action="/admin/access/tokens"><Csrf token={c.get('csrf')} />
          <div class="row"><div><label>Name</label><input name="name" required /></div><div><label>Owner</label><select name="serviceAccountId"><option value="">Me (personal access token)</option>{can(c, 'tokens:manage') ? svcs.map((s) => <option value={s.id}>service account {s.name}</option>) : null}</select></div>
            <div><label>Expires in days</label><input name="expiresInDays" type="number" min="1" max="365" value="30" /></div><div><label>Requests per minute</label><input name="rateLimitPerMinute" type="number" min="1" value="120" /></div></div>
          <label>Allowed source CIDRs (comma-separated, optional)</label><input name="allowedCidrs" placeholder="203.0.113.0/24, 2001:db8::/32" />
          <fieldset><legend>Scopes</legend>{myScopes.map((p) => <label><input type="checkbox" name="scopes" value={p} /> {p}{HIGH_RISK_SCOPES.has(p) ? ' (high risk)' : ''}</label>)}</fieldset>
          <button type="submit">Create token</button></form></details>
        {manage ? (
          <>
            <h2>Administrators</h2>
            <div class="table-wrap"><table><thead><tr><th>Email</th><th>Name</th><th>Roles</th><th>MFA</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>
              {adminRows.map((u) => <tr><td>{u.email}</td><td>{u.display_name}</td><td>{u.roles}</td><td>{u.totp_enrolled ? 'enrolled' : 'pending'}</td><td><Badge v={u.status} /></td><td>{fmt(u.last_login_at)}</td>
                <td><details><summary>Manage</summary>
                  <form method="post" action={`/admin/access/admins/${u.id}/roles`}><Csrf token={c.get('csrf')} />{roles.map((r) => <label><input type="checkbox" name="roles" value={r.id} checked={u.roles.split(',').includes(r.id)} /> {r.name}</label>)}<button type="submit">Set roles</button></form>
                  <form method="post" action={`/admin/access/admins/${u.id}/status`}><Csrf token={c.get('csrf')} /><input type="hidden" name="status" value={u.status === 'active' ? 'disabled' : 'active'} /><label>Type admin id to confirm</label><input name="confirm" placeholder={u.id} required /><button class={u.status === 'active' ? 'danger' : ''} type="submit">{u.status === 'active' ? 'Disable' : 'Enable'}</button></form>
                  <form method="post" action={`/admin/access/admins/${u.id}/reset-mfa`}><Csrf token={c.get('csrf')} /><label>Type admin id to confirm</label><input name="confirm" placeholder={u.id} required /><button class="secondary" type="submit">Reset authenticator</button></form>
                </details></td></tr>)}
            </tbody></table></div>
            <details class="card"><summary>Invite administrator</summary><form method="post" action="/admin/access/admins"><Csrf token={c.get('csrf')} />
              <div class="row"><div><label>Email</label><input name="email" type="email" required /></div><div><label>Name</label><input name="displayName" required /></div></div>
              {roles.map((r) => <label><input type="checkbox" name="roles" value={r.id} /> {r.name} — <span class="muted">{r.description}</span></label>)}
              <p class="muted">The invitee signs in with an email link and must enrol an authenticator before gaining access.</p><button type="submit">Invite</button></form></details>
            <h2>Service accounts</h2>
            <div class="table-wrap"><table><thead><tr><th>Name</th><th>Scope ceiling</th><th>Status</th><th></th></tr></thead><tbody>
              {svcs.map((s) => <tr><td>{s.name}<br /><code class="muted">{s.id}</code></td><td>{s.allowed_scopes.join(', ')}</td><td><Badge v={s.status} /></td><td><form class="inline" method="post" action={`/admin/access/service-accounts/${s.id}/status`}><Csrf token={c.get('csrf')} /><input type="hidden" name="status" value={s.status === 'active' ? 'disabled' : 'active'} /><button class="secondary" type="submit">{s.status === 'active' ? 'Disable' : 'Enable'}</button></form></td></tr>)}
            </tbody></table></div>
            <details class="card"><summary>New service account</summary><form method="post" action="/admin/access/service-accounts"><Csrf token={c.get('csrf')} />
              <label>Name</label><input name="name" pattern="[a-z0-9][a-z0-9_.-]{1,63}" required /><label>Description</label><input name="description" />
              <fieldset><legend>Scope ceiling</legend>{myScopes.map((p) => <label><input type="checkbox" name="allowedScopes" value={p} /> {p}</label>)}</fieldset><button type="submit">Create</button></form></details>
            <h2>Roles</h2>
            <div class="table-wrap"><table><thead><tr><th>Role</th><th>Permissions</th></tr></thead><tbody>{roles.map((r) => <tr><td>{r.name}</td><td class="muted">{r.permissions}</td></tr>)}</tbody></table></div>
          </>
        ) : null}
      </>
    ),
  });
});

const list = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
adminUi.post('/access/tokens', action(async (c, f) => {
  const t = await admins.createApiToken(c.get('deps').sql, c.get('deps').config, c.get('actor'), {
    name: f.name, serviceAccountId: strOrNull(f.serviceAccountId), scopes: list(f.scopes), expiresInDays: Number(f.expiresInDays || 30),
    allowedCidrs: list(f.allowedCidrs), rateLimitPerMinute: Number(f.rateLimitPerMinute || 120),
  });
  return render(c, { title: 'API token created', body: <div class="card"><h1>API token created</h1><p><b>Copy it now; it will never be shown again.</b> Store it in your password manager or macOS Keychain (see the runbook), not in shell history or dotfiles.</p><code class="secret">{t.token}</code><p>Scopes: {t.scopes.join(', ')} · expires {fmt(t.expiresAt)}</p><p><a href="/admin/access">Back</a></p></div> });
}));
adminUi.post('/access/tokens/:id/revoke', action(async (c) => (await admins.revokeApiToken(c.get('deps').sql, c.get('actor'), c.req.param('id')!, 'revoked in admin UI'), back(c, '/admin/access', 'Token revoked'))));
adminUi.post('/access/tokens/:id/rotate', action(async (c) => {
  const t = await admins.rotateApiToken(c.get('deps').sql, c.get('deps').config, c.get('actor'), c.req.param('id')!);
  return render(c, { title: 'Token rotated', body: <div class="card"><h1>Token rotated</h1><p>The old token is revoked. Copy the new one now:</p><code class="secret">{t.token}</code><p><a href="/admin/access">Back</a></p></div> });
}));
adminUi.post('/access/admins', action(async (c, f) => (await admins.inviteAdmin(c.get('deps').sql, c.get('actor'), { email: f.email, displayName: f.displayName, roles: list(f.roles) }, c.get('deps').config), back(c, '/admin/access', 'Administrator invited; they can now request a sign-in link'))));
adminUi.post('/access/admins/:id/roles', action(async (c, f) => (await admins.setAdminRoles(c.get('deps').sql, c.get('actor'), c.req.param('id')!, list(f.roles)), back(c, '/admin/access', 'Roles updated'))));
adminUi.post('/access/admins/:id/status', action(async (c, f) => {
  if (f.confirm?.trim() !== c.req.param('id')) throw new AppError('precondition_failed', 'Confirmation text did not match the administrator id');
  await admins.setAdminStatus(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.status as 'active');
  return back(c, '/admin/access', `Administrator ${f.status}`);
}));
adminUi.post('/access/admins/:id/reset-mfa', action(async (c, f) => {
  if (f.confirm?.trim() !== c.req.param('id')) throw new AppError('precondition_failed', 'Confirmation text did not match the administrator id');
  await admins.resetAdminTotp(c.get('deps').sql, c.get('actor'), c.req.param('id')!);
  return back(c, '/admin/access', 'Authenticator reset; sessions revoked');
}));
adminUi.post('/access/service-accounts', action(async (c, f) => (await admins.createServiceAccount(c.get('deps').sql, c.get('actor'), { name: f.name, description: f.description ?? '', allowedScopes: list(f.allowedScopes) }), back(c, '/admin/access', 'Service account created'))));
adminUi.post('/access/service-accounts/:id/status', action(async (c, f) => (await admins.setServiceAccountStatus(c.get('deps').sql, c.get('actor'), c.req.param('id')!, f.status as 'active'), back(c, '/admin/access', 'Updated'))));

// --------------------------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------------------------

adminUi.get('/audit', async (c) => {
  if (!can(c, 'audit:read')) return render(c, { title: 'Audit', flash: { kind: 'err', text: 'Missing permission audit:read' }, body: <p /> }, 403);
  const rows = await listAudit(c.get('deps').sql, { resourceType: c.req.query('resourceType') || undefined, resourceId: c.req.query('resourceId') || undefined, actorId: c.req.query('actorId') || undefined, action: c.req.query('action') || undefined, outcome: c.req.query('outcome') || undefined, beforeId: c.req.query('beforeId') ? Number(c.req.query('beforeId')) : undefined, limit: 100 });
  const last = rows[rows.length - 1];
  return render(c, {
    title: 'Audit log',
    body: (
      <>
        <h1>Audit log</h1>
        <form method="get" action="/admin/audit" class="row">
          {['resourceType', 'resourceId', 'actorId', 'action', 'outcome'].map((k) => <div><label for={k}>{k}</label><input id={k} name={k} value={c.req.query(k) ?? ''} /></div>)}<div><button type="submit">Filter</button></div></form>
        <AuditTable rows={rows} />
        {last ? <p><a href={`/admin/audit?${new URLSearchParams({ ...Object.fromEntries(Object.entries(c.req.query()).filter(([k]) => k !== 'beforeId')), beforeId: String(last.id) })}`}>Older →</a></p> : null}
      </>
    ),
  });
});
