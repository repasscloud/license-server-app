// /api/admin/v1 — scriptable administration API for terminals, CI and internal tools.
// Authentication: `Authorization: Bearer rpl_pat_…` / `rpl_svc_…` ONLY. Cookies are never read
// here, so there is no CSRF surface, and no browser login is ever required.
// Every call is authorised per route (scope ∩ owner's current permissions), audited, and
// mutations accept `Idempotency-Key`. Destructive operations require `confirm` = resource id.
// The admin UI calls the very same service functions with the same permission checks.

import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '../auth/permissions.ts';
import { AppError, forbidden, invalid } from '../lib/errors.ts';
import { requirePermission, type Actor } from '../services/actor.ts';
import { audit, listAudit } from '../services/audit.ts';
import * as admins from '../services/admins.ts';
import * as billing from '../services/billing.ts';
import * as catalogue from '../services/catalogue.ts';
import { listCheckouts } from '../services/checkout.ts';
import * as customers from '../services/customers.ts';
import * as email from '../services/email.ts';
import { getLicenseDetail, grantEntitlements, searchLicenses } from '../services/entitlements.ts';
import { withIdempotency } from '../services/idempotency.ts';
import { listJobs, retryDeadJob } from '../services/jobs.ts';
import * as licensing from '../services/licensing.ts';
import * as keys from '../services/signing-keys.ts';
import * as stripeSync from '../services/stripe-sync.ts';
import { isSignatureAlgorithm } from '../crypto/algorithms.ts';
import { type AppEnv, type Ctx, logError, readText, toAppError } from './context.ts';
import { openApiDocument } from './openapi.ts';

export const adminApi = new Hono<AppEnv>();

const MAX_BODY = 256 * 1024;

function errorBody(c: Ctx, e: AppError) {
  return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) }, requestId: c.get('requestId') };
}

adminApi.get('/openapi.json', (c) => c.json(openApiDocument(new URL(c.req.url).origin)));

// Authentication + per-request audit.
adminApi.use('*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) {
    c.header('WWW-Authenticate', 'Bearer realm="repass-admin"');
    return c.json(errorBody(c, new AppError('unauthorized', 'Bearer API token required')), 401);
  }
  const { sql, config } = c.get('deps');
  let actor: Actor;
  try {
    actor = await admins.authenticateApiToken(sql, config, m[1]!, c.get('ip'), c.get('ipHash'), c.get('requestId'));
  } catch (e) {
    if (e instanceof admins.TokenAuthError) {
      if (e.retryAfter) c.header('Retry-After', String(e.retryAfter));
      if (e.code === 'unauthorized') c.header('WWW-Authenticate', 'Bearer realm="repass-admin", error="invalid_token"');
      const status = e.code === 'unauthorized' ? 401 : e.code === 'forbidden' ? 403 : 429;
      return c.json(errorBody(c, new AppError(e.code === 'rate_limited' ? 'rate_limited' : e.code, e.message)), status);
    }
    logError(c, e);
    const ae = toAppError(e);
    return c.json(errorBody(c, ae), ae.status as 500);
  }
  c.set('actor', actor);
  await next();
  const status = c.res.status;
  try {
    await audit(sql, actor, {
      action: `api.${c.req.method.toLowerCase()}`,
      resourceType: 'api',
      resourceId: c.req.routePath,
      outcome: status < 400 ? 'success' : status === 401 || status === 403 ? 'denied' : 'failure',
      detail: { path: new URL(c.req.url).pathname, status, scopes: [...(actor.permissions ?? [])].length },
    });
  } catch (e) {
    logError(c, e);
  }
});

adminApi.onError((e, c) => {
  const ae = toAppError(e);
  if (ae.status >= 500) logError(c as Ctx, e);
  return c.json(errorBody(c as Ctx, ae), ae.status as 500);
});

const actor = (c: Ctx) => c.get('actor');
const need = (c: Ctx, p: string) => requirePermission(actor(c), p);
const q = (c: Ctx, k: string) => c.req.query(k) || undefined;
const page = (c: Ctx) => ({ limit: Math.min(Number(q(c, 'limit') ?? 50) || 50, 200), offset: Math.max(Number(q(c, 'offset') ?? 0) || 0, 0) });

async function readBody(c: Ctx): Promise<{ raw: string; data: Record<string, unknown> }> {
  const raw = await readText(c, MAX_BODY);
  if (!raw) return { raw, data: {} };
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) throw new AppError('invalid_request', 'Content-Type must be application/json');
  const v = JSON.parse(raw);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid('Body must be a JSON object');
  return { raw, data: v };
}

/** Wrap a mutation with Idempotency-Key handling. */
function mutation(status: number, fn: (c: Ctx, b: Record<string, unknown>) => Promise<unknown>) {
  return async (c: Ctx) => {
    const { raw, data } = await readBody(c);
    const a = actor(c);
    const r = await withIdempotency(c.get('deps').sql, a.id ?? 'unknown', c.req.header('idempotency-key') ?? null, { method: c.req.method, path: new URL(c.req.url).pathname, body: raw }, async () => ({ status, body: await fn(c, data) }));
    if (r.replayed) c.header('Idempotent-Replayed', 'true');
    return c.json(r.body as object, r.status as 200);
  };
}

function confirm(b: Record<string, unknown>, id: string) {
  if (b.confirm !== id) throw new AppError('precondition_failed', `Destructive operation: repeat the resource id in "confirm" (expected "${id}")`);
}

const list = <T>(data: T[], c: Ctx) => ({ data, page: page(c) });

// --- identity ------------------------------------------------------------------------------
adminApi.get('/me', (c) => c.json({ actor: { type: actor(c).type, id: actor(c).id, label: actor(c).label, principalId: actor(c).principalId ?? null }, permissions: [...(actor(c).permissions ?? [])].sort() }));
adminApi.get('/permissions', (c) => c.json({ data: Object.entries(PERMISSIONS).map(([id, description]) => ({ id, description })) }));

// --- catalogue -----------------------------------------------------------------------------
adminApi.get('/products', async (c) => (need(c, 'products:read'), c.json(list(await catalogue.listProducts(c.get('deps').sql, { status: q(c, 'status'), search: q(c, 'q'), ...page(c) }), c))));
adminApi.post('/products', mutation(201, (c, b) => catalogue.createProduct(c.get('deps').sql, actor(c), b)));
adminApi.get('/products/:id', async (c) => (need(c, 'products:read'), c.json(await catalogue.getProduct(c.get('deps').sql, c.req.param('id')))));
adminApi.patch('/products/:id', mutation(200, (c, b) => catalogue.updateProduct(c.get('deps').sql, actor(c), c.req.param('id')!, b)));
adminApi.post('/majors', mutation(201, (c, b) => catalogue.createMajor(c.get('deps').sql, actor(c), b)));
adminApi.get('/majors/:id', async (c) => (need(c, 'products:read'), c.json(await catalogue.getMajor(c.get('deps').sql, c.req.param('id')))));
adminApi.patch('/majors/:id', mutation(200, (c, b) => catalogue.updateMajor(c.get('deps').sql, actor(c), c.req.param('id')!, b)));
adminApi.post('/majors/:id/releases', mutation(200, (c, b) => catalogue.upsertRelease(c.get('deps').sql, actor(c), { ...b, productMajorId: c.req.param('id') })));
adminApi.put('/majors/:id/edition-policies/:editionId', mutation(200, (c, b) => catalogue.upsertEditionPolicy(c.get('deps').sql, actor(c), { ...b, productMajorId: c.req.param('id'), editionId: c.req.param('editionId') })));
adminApi.get('/offers', async (c) => (need(c, 'products:read'), c.json(list(await catalogue.listOffers(c.get('deps').sql, { status: q(c, 'status'), productId: q(c, 'productId'), ...page(c) }), c))));
adminApi.post('/offers', mutation(201, (c, b) => catalogue.createOffer(c.get('deps').sql, actor(c), b)));
adminApi.get('/offers/:id', async (c) => (need(c, 'products:read'), c.json(await catalogue.getOffer(c.get('deps').sql, c.req.param('id')))));
adminApi.patch('/offers/:id', mutation(200, (c, b) => catalogue.updateOffer(c.get('deps').sql, actor(c), c.req.param('id')!, b)));
adminApi.post('/offers/:id/status', mutation(200, (c, b) => catalogue.setOfferStatus(c.get('deps').sql, actor(c), c.req.param('id')!, z.enum(['active', 'archived', 'draft']).parse(b.status))));
adminApi.get('/offers/:id/prices', async (c) => (need(c, 'prices:read'), c.json({ data: await catalogue.listPriceHistory(c.get('deps').sql, c.req.param('id')) })));
adminApi.post('/prices', mutation(201, (c, b) => catalogue.createPriceVersion(c.get('deps').sql, actor(c), b)));
adminApi.post('/prices/:id/activate', mutation(200, (c) => catalogue.activatePriceVersion(c.get('deps').sql, actor(c), c.req.param('id')!)));
adminApi.post('/prices/:id/archive', mutation(200, (c) => catalogue.archivePriceVersion(c.get('deps').sql, actor(c), c.req.param('id')!)));

// --- stripe --------------------------------------------------------------------------------
adminApi.get('/stripe/mappings', async (c) => (need(c, 'prices:read'), c.json({ data: await stripeSync.listMappings(c.get('deps').sql) })));
adminApi.post('/stripe/sync', mutation(202, async (c, b) => {
  const input = z.object({ offerId: z.string().optional(), priceVersionId: z.string().optional(), wait: z.boolean().default(false) }).strict().parse(b);
  const { sql, stripe } = c.get('deps');
  if (!input.wait) {
    await stripeSync.requestSync(sql, actor(c), input);
    return { queued: true };
  }
  need(c, 'stripe:sync');
  const out: Record<string, string> = {};
  if (input.offerId) out.stripeProductId = await stripeSync.syncOffer(sql, stripe, input.offerId, actor(c));
  if (input.priceVersionId) out.stripePriceId = await stripeSync.syncPrice(sql, stripe, input.priceVersionId, actor(c));
  return out;
}));
adminApi.post('/stripe/prices/:id/repair', mutation(200, (c, b) => stripeSync.repairPriceMapping(c.get('deps').sql, c.get('deps').stripe, actor(c), c.req.param('id')!, z.enum(['retry', 'reactivate', 'recreate']).parse(b.action))));
adminApi.post('/stripe/drift-check', mutation(200, async (c) => (need(c, 'stripe:sync'), stripeSync.checkDrift(c.get('deps').sql, c.get('deps').stripe, 20))));

// --- customers, entitlements, licences -----------------------------------------------------
adminApi.get('/customers', async (c) => (need(c, 'customers:read'), c.json(list(await customers.listCustomers(c.get('deps').sql, { search: q(c, 'q'), ...page(c) }), c))));
adminApi.post('/customers', mutation(201, (c, b) => customers.createCustomer(c.get('deps').sql, actor(c), b)));
adminApi.get('/customers/:id', async (c) => (need(c, 'customers:read'), c.json(await customers.getCustomer(c.get('deps').sql, c.req.param('id')))));
adminApi.patch('/customers/:id', mutation(200, (c, b) => customers.updateCustomer(c.get('deps').sql, actor(c), c.req.param('id')!, b)));
adminApi.get('/customers/:id/entitlements', async (c) => (need(c, 'entitlements:read'), c.json({ data: await customers.listCustomerEntitlements(c.get('deps').sql, c.req.param('id')) })));
adminApi.post('/customers/:id/members', mutation(201, (c, b) => customers.addMember(c.get('deps').sql, actor(c), c.req.param('id')!, z.string().parse(b.email), z.enum(['admin', 'billing', 'member']).parse(b.role), c.get('deps').config)));
adminApi.delete('/customers/:id/members/:userId', mutation(200, async (c) => (await customers.removeMember(c.get('deps').sql, actor(c), c.req.param('id')!, c.req.param('userId')!), { removed: true })));
adminApi.post('/entitlements/grants', mutation(201, async (c, b) => {
  const r = await grantEntitlements(c.get('deps').sql, c.get('deps').config, actor(c), b);
  // Activation keys are returned once here (grant response) and are otherwise unrecoverable.
  return r;
}));
adminApi.get('/licenses', async (c) => (need(c, 'licenses:read'), c.json(list(await searchLicenses(c.get('deps').sql, { q: q(c, 'q'), status: q(c, 'status'), productSlug: q(c, 'product'), ...page(c) }), c))));
adminApi.get('/licenses/:id', async (c) => (need(c, 'licenses:read'), c.json(await getLicenseDetail(c.get('deps').sql, c.req.param('id')))));
adminApi.get('/licenses/:id/file', async (c) => {
  need(c, 'licenses:read');
  const f = await licensing.licenseFileForDownload(c.get('deps').sql, c.get('deps').config, actor(c), c.req.param('id'));
  c.header('Content-Disposition', `attachment; filename="${f.fileName}"`);
  return c.json(f.envelope);
});
adminApi.post('/licenses/:id/revoke', mutation(200, (c, b) => {
  confirm(b, c.req.param('id')!);
  return licensing.revokeEntitlement(c.get('deps').sql, actor(c), c.req.param('id')!, { reason: z.string().min(3).parse(b.reason) });
}));
adminApi.post('/licenses/:id/unrevoke', mutation(200, (c, b) => (confirm(b, c.req.param('id')!), licensing.unrevokeEntitlement(c.get('deps').sql, actor(c), c.req.param('id')!, z.string().min(3).parse(b.reason)))));
adminApi.post('/licenses/:id/reissue', mutation(200, (c, b) => licensing.reissueLicense(c.get('deps').sql, c.get('deps').config, actor(c), c.req.param('id')!, z.object({ reason: z.string().min(3), organisationName: z.string().nullable().optional(), customerName: z.string().nullable().optional() }).strict().parse(b))));
adminApi.post('/licenses/:id/amend', mutation(200, (c, b) => licensing.amendEntitlement(c.get('deps').sql, actor(c), c.req.param('id')!, z.object({ seats: z.number().int().optional(), transferAllowance: z.number().int().min(0).optional(), expiresAt: z.coerce.date().optional(), clearReview: z.boolean().optional(), reason: z.string().min(3) }).strict().parse(b))));
adminApi.post('/licenses/:id/activation-key/rotate', mutation(200, (c) => licensing.rotateActivationKey(c.get('deps').sql, c.get('deps').config, actor(c), c.req.param('id')!)));
adminApi.get('/licenses/:id/transfers', async (c) => (need(c, 'activations:read'), c.json(await licensing.transferStatus(c.get('deps').sql, c.req.param('id')))));
adminApi.post('/licenses/:id/transfers/grant', mutation(200, (c, b) => licensing.grantTransfers(c.get('deps').sql, actor(c), c.req.param('id')!, z.number().int().parse(b.amount), z.string().parse(b.reason))));
adminApi.post('/licenses/:id/transfers/reset', mutation(200, (c, b) => licensing.resetTransfers(c.get('deps').sql, actor(c), c.req.param('id')!, z.string().parse(b.reason))));
adminApi.post('/activations/:id/release', mutation(200, (c) => licensing.releaseActivation(c.get('deps').sql, actor(c), c.req.param('id')!, 'support', c.get('deps').config)));

// --- billing ---------------------------------------------------------------------------------
adminApi.get('/checkouts', async (c) => (need(c, 'checkouts:read'), c.json(list(await listCheckouts(c.get('deps').sql, { status: q(c, 'status'), limit: page(c).limit }), c))));
adminApi.get('/subscriptions', async (c) => {
  need(c, 'subscriptions:read');
  return c.json({ data: await c.get('deps').sql`SELECT s.*, c.display_name FROM subscriptions s JOIN customers c ON c.id = s.customer_id ORDER BY s.updated_at DESC LIMIT ${page(c).limit}` });
});
adminApi.post('/subscriptions/:stripeSubscriptionId/reconcile', mutation(200, async (c) => {
  need(c, 'subscriptions:manage');
  const { sql, config, stripe } = c.get('deps');
  return { outcome: await billing.syncSubscription(sql, config, stripe, actor(c), c.req.param('stripeSubscriptionId')!) };
}));
adminApi.get('/webhooks/stripe/events', async (c) => (need(c, 'webhooks:read'), c.json({ data: await billing.listStripeEvents(c.get('deps').sql, { status: q(c, 'status'), type: q(c, 'type'), limit: page(c).limit }) })));
adminApi.post('/webhooks/stripe/events/:id/replay', mutation(202, (c) => billing.replayStripeEvent(c.get('deps').sql, actor(c), c.req.param('id')!)));
adminApi.post('/webhooks/reconcile', mutation(200, async (c, b) => {
  need(c, 'webhooks:reconcile');
  const input = z.object({ kind: z.enum(['checkouts', 'subscriptions', 'backfill']), sinceSeconds: z.number().int().optional() }).strict().parse(b);
  const { sql, config, stripe } = c.get('deps');
  if (input.kind === 'checkouts') return { results: await billing.reconcileCheckouts(sql, config, stripe, 10) };
  if (input.kind === 'subscriptions') return { results: await billing.reconcileSubscriptions(sql, config, stripe, 10) };
  return billing.backfillEvents(sql, stripe, actor(c), input.sinceSeconds ?? Math.floor(Date.now() / 1000) - 3 * 86400);
}));
adminApi.get('/jobs', async (c) => (need(c, 'webhooks:read'), c.json({ data: await listJobs(c.get('deps').sql, { status: q(c, 'status'), kind: q(c, 'kind'), limit: page(c).limit }) })));
adminApi.post('/jobs/:id/retry', mutation(200, async (c) => {
  need(c, 'webhooks:reconcile');
  const ok = await retryDeadJob(c.get('deps').sql, Number(c.req.param('id')));
  if (!ok) throw new AppError('not_found', 'Dead job not found');
  return { retried: true };
}));

// --- signing keys ----------------------------------------------------------------------------
adminApi.get('/signing-keys', async (c) => (need(c, 'signing_keys:read_public'), c.json({ data: await keys.listSigningKeys(c.get('deps').sql) })));
adminApi.get('/signing-keys/compatibility', async (c) => (need(c, 'signing_keys:read_public'), c.json({ data: await keys.listCompatibilities(c.get('deps').sql, { productMajorId: q(c, 'productMajorId'), keyId: q(c, 'keyId') }) })));
adminApi.get('/signing-keys/trusted-export', async (c) => (need(c, 'signing_keys:read_public'), c.json({ data: await keys.exportTrustedKeys(c.get('deps').sql, q(c, 'productMajorId')) })));
adminApi.post('/signing-keys', mutation(201, (c, b) => {
  need(c, 'signing_keys:manage');
  const input = z.object({ algorithm: z.string(), keyId: z.string().optional(), notes: z.string().max(500).optional() }).strict().parse(b);
  if (!isSignatureAlgorithm(input.algorithm)) throw invalid('algorithm must be Ed25519, ECDSA-P256-SHA256 or ML-DSA-65');
  return keys.generateSigningKey(c.get('deps').sql, c.get('deps').config.signingKeks, actor(c), { algorithm: input.algorithm, keyId: input.keyId, notes: input.notes });
}));
adminApi.get('/signing-keys/:id', async (c) => (need(c, 'signing_keys:read_public'), c.json(await keys.getSigningKey(c.get('deps').sql, c.req.param('id')))));
adminApi.post('/signing-keys/:id/publish', mutation(200, (c) => (need(c, 'signing_keys:manage'), keys.publishSigningKey(c.get('deps').sql, actor(c), c.req.param('id')!))));
adminApi.put('/signing-keys/:id/trust', mutation(200, (c, b) => {
  need(c, 'signing_keys:manage');
  const input = z.object({ productMajorId: z.string(), trustedSinceVersion: z.string(), trustedUntilVersion: z.string().nullable().optional() }).strict().parse(b);
  return keys.setKeyTrust(c.get('deps').sql, actor(c), { keyId: c.req.param('id')!, ...input });
}));
adminApi.post('/signing-keys/:id/eligibility', mutation(200, (c, b) => {
  need(c, 'signing_keys:manage');
  const input = z.object({ productMajorId: z.string(), eligible: z.boolean() }).strict().parse(b);
  return keys.setKeyEligibility(c.get('deps').sql, actor(c), { keyId: c.req.param('id')!, ...input });
}));
adminApi.post('/signing-keys/:id/retire', mutation(200, (c, b) => {
  need(c, 'signing_keys:manage');
  confirm(b, c.req.param('id')!);
  return keys.retireSigningKey(c.get('deps').sql, actor(c), c.req.param('id')!, { reason: z.string().min(3).parse(b.reason), force: b.force === true });
}));
adminApi.post('/signing-keys/:id/compromise', mutation(200, (c, b) => {
  need(c, 'signing_keys:manage');
  confirm(b, c.req.param('id')!);
  return keys.retireSigningKey(c.get('deps').sql, actor(c), c.req.param('id')!, { reason: z.string().min(3).parse(b.reason), compromised: true });
}));
adminApi.post('/signing-keys/rewrap', mutation(200, (c, b) => {
  need(c, 'signing_keys:manage');
  return keys.rewrapSigningKeys(c.get('deps').sql, c.get('deps').config.signingKeks, actor(c), z.number().int().min(1).parse(b.toVersion), 20);
}));

// --- email -----------------------------------------------------------------------------------
adminApi.get('/email/outbox', async (c) => (need(c, 'email:read'), c.json({ data: await email.listEmails(c.get('deps').sql, { status: q(c, 'status'), limit: page(c).limit }) })));
adminApi.post('/email/retry', mutation(200, (c, b) => email.retryEmail(c.get('deps').sql, actor(c), z.string().parse(b.id))));
adminApi.post('/email/:id/resolve', mutation(200, (c, b) => email.markEmailResolved(c.get('deps').sql, actor(c), c.req.param('id')!, z.enum(['sent', 'dead']).parse(b.outcome))));
adminApi.get('/email/templates', async (c) => (need(c, 'email:read'), c.json({ data: await email.listTemplates(c.get('deps').sql) })));
adminApi.patch('/email/templates/:id', mutation(200, async (c, b) => {
  const input = z.object({ subject: z.string().max(998).optional(), htmlBody: z.string().max(200_000).optional(), textBody: z.string().max(200_000).optional(), mailersendTemplateId: z.string().nullable().optional(), status: z.enum(['active', 'disabled']).optional() }).strict().parse(b);
  await email.updateTemplate(c.get('deps').sql, actor(c), c.req.param('id')!, input);
  return { updated: true };
}));

// --- audit -----------------------------------------------------------------------------------
adminApi.get('/audit', async (c) => {
  need(c, 'audit:read');
  return c.json({ data: await listAudit(c.get('deps').sql, { resourceType: q(c, 'resourceType'), resourceId: q(c, 'resourceId'), actorId: q(c, 'actorId'), action: q(c, 'action'), outcome: q(c, 'outcome'), beforeId: q(c, 'beforeId') ? Number(q(c, 'beforeId')) : undefined, limit: page(c).limit }) });
});

// --- tokens, admins, service accounts --------------------------------------------------------
adminApi.get('/tokens', async (c) => c.json({ data: await admins.listApiTokens(c.get('deps').sql, actor(c)) }));
adminApi.post('/tokens', mutation(201, (c, b) => admins.createApiToken(c.get('deps').sql, c.get('deps').config, actor(c), b)));
adminApi.post('/tokens/:id/revoke', mutation(200, (c, b) => admins.revokeApiToken(c.get('deps').sql, actor(c), c.req.param('id')!, typeof b.reason === 'string' ? b.reason : 'revoked via API')));
adminApi.post('/tokens/:id/rotate', mutation(201, (c, b) => admins.rotateApiToken(c.get('deps').sql, c.get('deps').config, actor(c), c.req.param('id')!, { expiresInDays: typeof b.expiresInDays === 'number' ? b.expiresInDays : undefined })));
adminApi.get('/admins', async (c) => (need(c, 'admins:manage'), c.json({ data: await admins.listAdmins(c.get('deps').sql) })));
adminApi.post('/admins', mutation(201, (c, b) => admins.inviteAdmin(c.get('deps').sql, actor(c), b, c.get('deps').config)));
adminApi.put('/admins/:id/roles', mutation(200, (c, b) => admins.setAdminRoles(c.get('deps').sql, actor(c), c.req.param('id')!, z.array(z.string()).parse(b.roles))));
adminApi.post('/admins/:id/status', mutation(200, (c, b) => (confirm(b, c.req.param('id')!), admins.setAdminStatus(c.get('deps').sql, actor(c), c.req.param('id')!, z.enum(['active', 'disabled']).parse(b.status)))));
adminApi.post('/admins/:id/reset-mfa', mutation(200, async (c, b) => (confirm(b, c.req.param('id')!), await admins.resetAdminTotp(c.get('deps').sql, actor(c), c.req.param('id')!), { reset: true })));
adminApi.get('/roles', async (c) => (need(c, 'admins:manage'), c.json({ data: await admins.listRoles(c.get('deps').sql) })));
adminApi.get('/service-accounts', async (c) => (need(c, 'admins:manage'), c.json({ data: await admins.listServiceAccounts(c.get('deps').sql) })));
adminApi.post('/service-accounts', mutation(201, (c, b) => admins.createServiceAccount(c.get('deps').sql, actor(c), b)));
adminApi.post('/service-accounts/:id/status', mutation(200, (c, b) => admins.setServiceAccountStatus(c.get('deps').sql, actor(c), c.req.param('id')!, z.enum(['active', 'disabled']).parse(b.status))));

// --- system ----------------------------------------------------------------------------------
adminApi.get('/system/health', async (c) => {
  if (!actor(c).permissions?.has('webhooks:read') && !actor(c).permissions?.has('audit:read')) throw forbidden();
  const { sql, config } = c.get('deps');
  const [stats] = await sql<Record<string, number>[]>`
    SELECT (SELECT count(*)::int FROM outbox_jobs WHERE status = 'pending') AS jobs_pending,
           (SELECT count(*)::int FROM outbox_jobs WHERE status = 'dead') AS jobs_dead,
           (SELECT count(*)::int FROM email_outbox WHERE status IN ('pending', 'failed')) AS email_pending,
           (SELECT count(*)::int FROM email_outbox WHERE status IN ('dead', 'uncertain')) AS email_attention,
           (SELECT count(*)::int FROM stripe_events WHERE status IN ('failed', 'dead')) AS stripe_events_failed,
           (SELECT count(*)::int FROM stripe_price_mappings WHERE sync_state IN ('failed', 'drifted')) AS stripe_mappings_attention,
           (SELECT count(*)::int FROM entitlements WHERE review_required) AS entitlements_review`;
  return c.json({ environment: config.environment, missingSecrets: config.missingSecrets(), mailTransport: config.mailTransport, stripeLivemode: c.get('deps').stripe.livemode, stats });
});

adminApi.all('*', (c) => c.json(errorBody(c, new AppError('not_found', 'Unknown admin API route')), 404));
