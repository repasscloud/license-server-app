// OpenAPI 3.1 description of the REST surfaces: the binding v1 machine API, the admin API and
// the webhook receivers. Served at /api/admin/v1/openapi.json and exported to
// docs/api/openapi.json by scripts/export-openapi.ts.

type Op = { method: string; path: string; summary: string; scope?: string; body?: string; example?: unknown; destructive?: boolean; idempotent?: boolean; tag: string };

const A = '/api/admin/v1';
const ADMIN_OPS: Op[] = [
  { tag: 'Identity', method: 'get', path: `${A}/me`, summary: 'Current token identity and effective permissions' },
  { tag: 'Identity', method: 'get', path: `${A}/permissions`, summary: 'Permission/scope catalogue' },
  { tag: 'Catalogue', method: 'get', path: `${A}/products`, summary: 'List products (?q, ?status, ?limit, ?offset)', scope: 'products:read' },
  { tag: 'Catalogue', method: 'post', path: `${A}/products`, summary: 'Create a product (immutable slug = wire productId)', scope: 'products:write', body: 'CreateProduct', example: { slug: 'cursedelete', name: 'CurseDelete', description: 'Secure deletion tool' } },
  { tag: 'Catalogue', method: 'get', path: `${A}/products/{id}`, summary: 'Product with majors (id or slug)', scope: 'products:read' },
  { tag: 'Catalogue', method: 'patch', path: `${A}/products/{id}`, summary: 'Update product (name, description, status, visibility)', scope: 'products:write', example: { status: 'active' } },
  { tag: 'Catalogue', method: 'post', path: `${A}/majors`, summary: 'Create a product major bound to a wire protocol', scope: 'products:write', example: { productId: 'cursedelete', majorVersion: 2, protocolId: 'repass-v1', defaultTransferAllowance: 3, activationKeyEmail: true } },
  { tag: 'Catalogue', method: 'get', path: `${A}/majors/{id}`, summary: 'Major with releases and edition policies', scope: 'products:read' },
  { tag: 'Catalogue', method: 'patch', path: `${A}/majors/{id}`, summary: 'Update major (status, defaults)', scope: 'products:write', example: { status: 'active' } },
  { tag: 'Catalogue', method: 'post', path: `${A}/majors/{id}/releases`, summary: 'Upsert an application release (set minimum supported)', scope: 'products:write', example: { version: '2.1.0', status: 'shipped', isMinimumSupported: true } },
  { tag: 'Catalogue', method: 'put', path: `${A}/majors/{id}/edition-policies/{editionId}`, summary: 'Upsert an edition policy (validated against the protocol)', scope: 'products:write', example: { displayName: 'Business', activationModel: 'device_seats', ownership: 'organisation', transferAllowance: 3 } },
  { tag: 'Catalogue', method: 'get', path: `${A}/offers`, summary: 'List offers/SKUs', scope: 'products:read' },
  { tag: 'Catalogue', method: 'post', path: `${A}/offers`, summary: 'Create an offer (single or bundle) with entitlement components', scope: 'products:write', example: { sku: 'cd2-business-annual', name: 'CurseDelete 2 Business (annual, per seat)', kind: 'single', billing: 'recurring', maxQuantity: 100, components: [{ editionPolicyId: 'pep_…', termType: 'subscription', seatsPerUnit: 1, quantityScalesSeats: true, graceDays: 7 }] } },
  { tag: 'Catalogue', method: 'get', path: `${A}/offers/{id}`, summary: 'Offer with components, price history and Stripe mappings', scope: 'products:read' },
  { tag: 'Catalogue', method: 'patch', path: `${A}/offers/{id}`, summary: 'Update offer metadata (components are immutable once created)', scope: 'products:write' },
  { tag: 'Catalogue', method: 'post', path: `${A}/offers/{id}/status`, summary: 'Activate/archive an offer (activation requires a synced price)', scope: 'products:write', example: { status: 'active' } },
  { tag: 'Pricing', method: 'get', path: `${A}/offers/{id}/prices`, summary: 'Immutable price history', scope: 'prices:read' },
  { tag: 'Pricing', method: 'post', path: `${A}/prices`, summary: 'Create a draft price version (minor units) and queue Stripe Price creation', scope: 'prices:write', example: { offerId: 'off_…', currency: 'AUD', unitAmount: 4900, recurringInterval: 'year', taxBehavior: 'exclusive' } },
  { tag: 'Pricing', method: 'post', path: `${A}/prices/{id}/activate`, summary: 'Make a synced price version sellable (archives the previous one)', scope: 'prices:write' },
  { tag: 'Pricing', method: 'post', path: `${A}/prices/{id}/archive`, summary: 'Archive a price version (existing subscriptions unaffected)', scope: 'prices:write' },
  { tag: 'Stripe', method: 'get', path: `${A}/stripe/mappings`, summary: 'Stripe product/price mappings and sync/drift state', scope: 'prices:read' },
  { tag: 'Stripe', method: 'post', path: `${A}/stripe/sync`, summary: 'Queue (or with wait:true, run) Stripe sync for an offer/price', scope: 'stripe:sync', example: { priceVersionId: 'prc_…', wait: true } },
  { tag: 'Stripe', method: 'post', path: `${A}/stripe/prices/{id}/repair`, summary: 'Repair a failed/drifted mapping: retry | reactivate | recreate', scope: 'stripe:sync', example: { action: 'retry' } },
  { tag: 'Stripe', method: 'post', path: `${A}/stripe/drift-check`, summary: 'Compare mapped Stripe prices with the database', scope: 'stripe:sync' },
  { tag: 'Customers', method: 'get', path: `${A}/customers`, summary: 'Search customers (?q)', scope: 'customers:read' },
  { tag: 'Customers', method: 'post', path: `${A}/customers`, summary: 'Create a customer', scope: 'customers:write', example: { kind: 'organisation', displayName: 'Example Pty Ltd', organisationName: 'Example Pty Ltd', billingEmail: 'it@example.com' } },
  { tag: 'Customers', method: 'get', path: `${A}/customers/{id}`, summary: 'Customer with members', scope: 'customers:read' },
  { tag: 'Customers', method: 'patch', path: `${A}/customers/{id}`, summary: 'Correct customer details', scope: 'customers:write' },
  { tag: 'Customers', method: 'get', path: `${A}/customers/{id}/entitlements`, summary: 'Entitlements and licences of a customer', scope: 'entitlements:read' },
  { tag: 'Customers', method: 'post', path: `${A}/customers/{id}/members`, summary: 'Add a portal member', scope: 'customers:write', example: { email: 'colleague@example.com', role: 'member' } },
  { tag: 'Customers', method: 'delete', path: `${A}/customers/{id}/members/{userId}`, summary: 'Remove a portal member', scope: 'customers:write' },
  { tag: 'Licensing', method: 'post', path: `${A}/entitlements/grants`, summary: 'Grant entitlements from an offer (returns activation keys ONCE)', scope: 'entitlements:issue', example: { customerId: 'cus_…', offerSku: 'cd2-enterprise', quantity: 1, reason: 'Partner licence' } },
  { tag: 'Licensing', method: 'get', path: `${A}/licenses`, summary: 'Search licences (?q, ?status, ?product)', scope: 'licenses:read' },
  { tag: 'Licensing', method: 'get', path: `${A}/licenses/{id}`, summary: 'Licence detail: entitlement, snapshot, activations, issuances, revocations', scope: 'licenses:read' },
  { tag: 'Licensing', method: 'get', path: `${A}/licenses/{id}/file`, summary: 'Download the signed licence envelope', scope: 'licenses:read' },
  { tag: 'Licensing', method: 'post', path: `${A}/licenses/{id}/revoke`, summary: 'Revoke (affects future server interactions only; offline installs are not remotely disabled)', scope: 'entitlements:revoke', destructive: true, example: { reason: 'chargeback', confirm: 'lic_…' } },
  { tag: 'Licensing', method: 'post', path: `${A}/licenses/{id}/unrevoke`, summary: 'Reverse a revocation', scope: 'entitlements:revoke', destructive: true, example: { reason: 'dispute won', confirm: 'lic_…' } },
  { tag: 'Licensing', method: 'post', path: `${A}/licenses/{id}/reissue`, summary: 'Re-sign with the same licenseId (optionally correct names)', scope: 'licenses:issue', example: { reason: 'organisation renamed', organisationName: 'New Name Pty Ltd' } },
  { tag: 'Licensing', method: 'post', path: `${A}/licenses/{id}/amend`, summary: 'Audited policy amendment (seats, transfer allowance, expiry)', scope: 'entitlements:issue', example: { seats: 5, reason: 'upgrade agreed by sales' } },
  { tag: 'Licensing', method: 'post', path: `${A}/licenses/{id}/activation-key/rotate`, summary: 'Rotate the activation key (returned once)', scope: 'licenses:issue' },
  { tag: 'Licensing', method: 'get', path: `${A}/licenses/{id}/transfers`, summary: 'Rolling 365-day transfer usage', scope: 'activations:read' },
  { tag: 'Licensing', method: 'post', path: `${A}/licenses/{id}/transfers/grant`, summary: 'Grant extra transfers', scope: 'transfers:write', example: { amount: 1, reason: 'hardware failure' } },
  { tag: 'Licensing', method: 'post', path: `${A}/licenses/{id}/transfers/reset`, summary: 'Reset the transfer window', scope: 'transfers:write', example: { reason: 'annual review' } },
  { tag: 'Licensing', method: 'post', path: `${A}/activations/{id}/release`, summary: 'Release a device seat (device learns on next renew)', scope: 'activations:release' },
  { tag: 'Billing', method: 'get', path: `${A}/checkouts`, summary: 'Checkouts (?status)', scope: 'checkouts:read' },
  { tag: 'Billing', method: 'get', path: `${A}/subscriptions`, summary: 'Subscriptions', scope: 'subscriptions:read' },
  { tag: 'Billing', method: 'post', path: `${A}/subscriptions/{stripeSubscriptionId}/reconcile`, summary: 'Re-sync one subscription from Stripe', scope: 'subscriptions:manage' },
  { tag: 'Billing', method: 'get', path: `${A}/webhooks/stripe/events`, summary: 'Stripe event inbox (?status=failed|dead)', scope: 'webhooks:read' },
  { tag: 'Billing', method: 'post', path: `${A}/webhooks/stripe/events/{id}/replay`, summary: 'Replay a stored Stripe event', scope: 'webhooks:reconcile' },
  { tag: 'Billing', method: 'post', path: `${A}/webhooks/reconcile`, summary: 'Reconcile checkouts/subscriptions or backfill events from the Stripe Events API', scope: 'webhooks:reconcile', example: { kind: 'backfill', sinceSeconds: 1760140800 } },
  { tag: 'Billing', method: 'get', path: `${A}/jobs`, summary: 'Background jobs (?status=dead)', scope: 'webhooks:read' },
  { tag: 'Billing', method: 'post', path: `${A}/jobs/{id}/retry`, summary: 'Retry a dead job', scope: 'webhooks:reconcile' },
  { tag: 'Signing keys', method: 'get', path: `${A}/signing-keys`, summary: 'Key metadata and PUBLIC keys (private keys are never returned)', scope: 'signing_keys:read_public' },
  { tag: 'Signing keys', method: 'post', path: `${A}/signing-keys`, summary: 'Generate a keypair (does not change issuance)', scope: 'signing_keys:manage', example: { algorithm: 'Ed25519', keyId: 'repass-ed25519-2027' } },
  { tag: 'Signing keys', method: 'get', path: `${A}/signing-keys/compatibility`, summary: 'Key trust/eligibility per product major', scope: 'signing_keys:read_public' },
  { tag: 'Signing keys', method: 'get', path: `${A}/signing-keys/trusted-export`, summary: 'Public key export for application teams', scope: 'signing_keys:read_public' },
  { tag: 'Signing keys', method: 'get', path: `${A}/signing-keys/{id}`, summary: 'One key', scope: 'signing_keys:read_public' },
  { tag: 'Signing keys', method: 'post', path: `${A}/signing-keys/{id}/publish`, summary: 'Mark public key as handed to application teams', scope: 'signing_keys:manage' },
  { tag: 'Signing keys', method: 'put', path: `${A}/signing-keys/{id}/trust`, summary: 'Record which releases of a major embed the key', scope: 'signing_keys:manage', example: { productMajorId: 'pmj_…', trustedSinceVersion: '2.1.0' } },
  { tag: 'Signing keys', method: 'post', path: `${A}/signing-keys/{id}/eligibility`, summary: 'Mark eligible for issuance (requires minimum supported release to trust it)', scope: 'signing_keys:manage', example: { productMajorId: 'pmj_…', eligible: true } },
  { tag: 'Signing keys', method: 'post', path: `${A}/signing-keys/{id}/retire`, summary: 'Stop signing with a key', scope: 'signing_keys:manage', destructive: true, example: { reason: 'annual rotation', confirm: 'repass-ed25519-2026' } },
  { tag: 'Signing keys', method: 'post', path: `${A}/signing-keys/{id}/compromise`, summary: 'Mark compromised (immediately ineligible everywhere)', scope: 'signing_keys:manage', destructive: true, example: { reason: 'suspected exposure', confirm: 'repass-ed25519-2026' } },
  { tag: 'Signing keys', method: 'post', path: `${A}/signing-keys/rewrap`, summary: 'Re-encrypt private keys under another KEK version (batch of 20)', scope: 'signing_keys:manage', example: { toVersion: 2 } },
  { tag: 'Email', method: 'get', path: `${A}/email/outbox`, summary: 'Email outbox (?status)', scope: 'email:read' },
  { tag: 'Email', method: 'post', path: `${A}/email/retry`, summary: 'Retry a failed/dead/uncertain email', scope: 'email:retry', example: { id: 'eml_…' } },
  { tag: 'Email', method: 'post', path: `${A}/email/{id}/resolve`, summary: 'Resolve an uncertain email after checking MailerSend', scope: 'email:retry', example: { outcome: 'sent' } },
  { tag: 'Email', method: 'get', path: `${A}/email/templates`, summary: 'Email templates', scope: 'email:read' },
  { tag: 'Email', method: 'patch', path: `${A}/email/templates/{id}`, summary: 'Edit a template / MailerSend template mapping', scope: 'email:templates' },
  { tag: 'Audit', method: 'get', path: `${A}/audit`, summary: 'Audit log (?resourceType, ?resourceId, ?actorId, ?action prefix, ?outcome, ?beforeId)', scope: 'audit:read' },
  { tag: 'Tokens', method: 'get', path: `${A}/tokens`, summary: 'Own tokens (all with tokens:manage); never returns secrets' },
  { tag: 'Tokens', method: 'post', path: `${A}/tokens`, summary: 'Create a token for a service account (tokens:manage); secret shown once', scope: 'tokens:manage', example: { name: 'ci-catalogue', serviceAccountId: 'svc_…', scopes: ['products:read'], expiresInDays: 30, allowedCidrs: ['203.0.113.0/24'] } },
  { tag: 'Tokens', method: 'post', path: `${A}/tokens/{id}/revoke`, summary: 'Revoke a token (own, or any with tokens:manage)', example: { reason: 'laptop retired' } },
  { tag: 'Tokens', method: 'post', path: `${A}/tokens/{id}/rotate`, summary: 'Rotate: new secret (shown once), old revoked', scope: 'tokens:manage' },
  { tag: 'Administration', method: 'get', path: `${A}/admins`, summary: 'Administrators', scope: 'admins:manage' },
  { tag: 'Administration', method: 'post', path: `${A}/admins`, summary: 'Invite an administrator', scope: 'admins:manage', example: { email: 'ops@repasscloud.com', displayName: 'Ops', roles: ['support'] } },
  { tag: 'Administration', method: 'put', path: `${A}/admins/{id}/roles`, summary: 'Set roles', scope: 'admins:manage', example: { roles: ['support', 'billing'] } },
  { tag: 'Administration', method: 'post', path: `${A}/admins/{id}/status`, summary: 'Enable/disable (revokes sessions and tokens)', scope: 'admins:manage', destructive: true, example: { status: 'disabled', confirm: 'adm_…' } },
  { tag: 'Administration', method: 'post', path: `${A}/admins/{id}/reset-mfa`, summary: 'Reset authenticator', scope: 'admins:manage', destructive: true, example: { confirm: 'adm_…' } },
  { tag: 'Administration', method: 'get', path: `${A}/roles`, summary: 'Roles and permissions', scope: 'admins:manage' },
  { tag: 'Administration', method: 'get', path: `${A}/service-accounts`, summary: 'Service accounts', scope: 'admins:manage' },
  { tag: 'Administration', method: 'post', path: `${A}/service-accounts`, summary: 'Create a service account with a scope ceiling', scope: 'admins:manage', example: { name: 'ci-catalogue', allowedScopes: ['products:read', 'prices:read'] } },
  { tag: 'Administration', method: 'post', path: `${A}/service-accounts/{id}/status`, summary: 'Enable/disable a service account (revokes its tokens)', scope: 'admins:manage', example: { status: 'disabled' } },
  { tag: 'Administration', method: 'get', path: `${A}/system/health`, summary: 'Operational health: missing secret NAMES, queue/outbox stats', scope: 'webhooks:read' },
];

const machineError = { $ref: '#/components/schemas/MachineError' };
const machineResp = (codes: Record<string, string>) => Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, { description: v, content: { 'application/json': { schema: machineError } } }]));

export function openApiDocument(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of ADMIN_OPS) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const mutating = op.method !== 'get';
    if (mutating) params.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } } as never);
    paths[op.path] ??= {};
    paths[op.path]![op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: `${op.scope ? `Requires scope \`${op.scope}\`.` : 'Any valid token.'}${op.destructive ? ' Destructive: body must include `confirm` equal to the resource id.' : ''}`,
      security: [{ adminToken: [] }],
      parameters: params,
      ...(mutating ? { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' }, ...(op.example ? { example: op.example } : {}) } } } } : {}),
      responses: {
        [op.method === 'post' && /create|Create|Generate|Grant|Invite/.test(op.summary) ? '201' : '200']: { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': { $ref: '#/components/responses/Error' },
        '401': { $ref: '#/components/responses/Error' },
        '403': { $ref: '#/components/responses/Error' },
        '404': { $ref: '#/components/responses/Error' },
        '409': { $ref: '#/components/responses/Error' },
        '412': { $ref: '#/components/responses/Error' },
        '422': { $ref: '#/components/responses/Error' },
        '429': { $ref: '#/components/responses/Error' },
        '503': { $ref: '#/components/responses/Error' },
      },
    };
  }
  paths['/v1/activations'] = {
    post: {
      tags: ['Machine API v1 (binding)'], summary: 'Activate (business) or provision (other editions)', security: [],
      description: 'Binding contract: LICENSING-SERVER-BRIEF.md §5.1. Authenticated by the activation key. Rate limited per IP and key.',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivateRequest' }, example: { productId: 'cursedelete', majorVersion: 2, activationKey: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567', deviceId: '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF', clientSecret: 'q0V9nbg2u6zq1o0sR1JjKXz5a0vDqzM3o9o7fJx4mWc' } } } },
      responses: { '200': { description: 'Licence and (business) activation certificate', content: { 'application/json': { schema: { $ref: '#/components/schemas/MachineResponse' } } } }, ...machineResp({ '400': 'invalid_request', '403': 'revoked', '404': 'invalid_key', '409': 'seat_limit | transfer_limit | subscription_expired', '422': 'product_mismatch | version_mismatch', '429': 'rate_limited', '503': 'server_error' }) },
    },
  };
  paths['/v1/licenses/{licenseId}/renew'] = {
    post: {
      tags: ['Machine API v1 (binding)'], summary: 'Fresh licence (same licenseId) and, with a valid activation, a fresh certificate', security: [],
      parameters: [{ name: 'licenseId', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,128}$' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RenewRequest' } } } },
      responses: { '200': { description: 'Renewed', content: { 'application/json': { schema: { $ref: '#/components/schemas/MachineResponse' } } } }, ...machineResp({ '400': 'invalid_request', '401': 'unauthorized', '403': 'revoked', '404': 'not_found', '409': 'activation_inactive | subscription_expired', '422': 'product_mismatch | version_mismatch', '429': 'rate_limited', '503': 'server_error' }) },
    },
  };
  paths['/v1/activations/{activationId}/deactivate'] = {
    post: {
      tags: ['Machine API v1 (binding)'], summary: 'Release a business seat', security: [],
      parameters: [{ name: 'activationId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DeactivateRequest' } } } },
      responses: { '204': { description: 'Released' }, ...machineResp({ '400': 'invalid_request', '401': 'unauthorized', '404': 'not_found', '409': 'activation_inactive (client treats as success)', '422': 'product_mismatch | version_mismatch', '429': 'rate_limited', '503': 'server_error' }) },
    },
  };
  paths['/webhooks/stripe'] = { post: { tags: ['Webhooks'], summary: 'Stripe events (Stripe-Signature verified on raw body)', security: [], responses: { '200': { description: 'Stored or duplicate' }, '400': { description: 'invalid_signature' }, '500': { description: 'Not stored; Stripe retries' } } } };
  paths['/webhooks/mailersend'] = { post: { tags: ['Webhooks'], summary: 'MailerSend delivery events (Signature header verified); 404 when not configured', security: [], responses: { '200': { description: 'Processed' }, '400': { description: 'invalid_signature' }, '404': { description: 'Webhook not configured' } } } };

  const sig = { type: 'object', additionalProperties: false, required: ['signatureAlgorithm', 'keyId', 'signature'], properties: { signatureAlgorithm: { enum: ['Ed25519', 'ECDSA-P256-SHA256', 'ML-DSA-65'] }, keyId: { type: 'string' }, signature: { type: 'string', description: 'base64url (unpadded)' } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'RePassCloud Licensing API',
      version: '1.0.0',
      description: 'Admin API: bearer tokens (`rpl_pat_…` / `rpl_svc_…`) only — no cookies, no browser login. Machine API v1: binding contract from LICENSING-SERVER-BRIEF.md; authenticated by activation key / client secret. Errors: admin `{error:{code,message,details?},requestId}`; machine `{error,message}`.',
    },
    servers: [{ url: origin }],
    tags: [...new Set(ADMIN_OPS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { adminToken: { type: 'http', scheme: 'bearer', bearerFormat: 'rpl_pat_<16>_<43> | rpl_svc_<16>_<43>' } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminError' } } } } },
      schemas: {
        AdminError: { type: 'object', required: ['error', 'requestId'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { enum: ['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'precondition_failed', 'rate_limited', 'validation_failed', 'protocol_incompatible', 'provider_unavailable', 'internal'] }, message: { type: 'string' }, details: {} } }, requestId: { type: 'string' } } },
        MachineError: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' } } },
        Envelope: { type: 'object', additionalProperties: false, required: ['format', 'payload', 'signatures'], properties: { format: { enum: ['repass-license-v1', 'repass-activation-v1'] }, payload: { type: 'string', description: 'base64url(UTF-8 claims JSON)' }, signatures: { type: 'array', minItems: 1, maxItems: 8, items: sig } } },
        MachineResponse: { type: 'object', required: ['license', 'activation'], properties: { license: { $ref: '#/components/schemas/Envelope' }, activation: { oneOf: [{ $ref: '#/components/schemas/Envelope' }, { type: 'null' }] } } },
        ActivateRequest: { type: 'object', additionalProperties: false, required: ['productId', 'majorVersion', 'activationKey', 'deviceId', 'clientSecret'], properties: { productId: { type: 'string' }, majorVersion: { type: 'integer' }, activationKey: { type: 'string', maxLength: 256 }, deviceId: { type: 'string', maxLength: 256 }, clientSecret: { type: 'string', description: 'base64url of 32 random bytes' } } },
        RenewRequest: { type: 'object', additionalProperties: false, required: ['productId', 'majorVersion'], properties: { productId: { type: 'string' }, majorVersion: { type: 'integer' }, activation: { type: ['object', 'null'], additionalProperties: false, required: ['activationId', 'deviceId', 'clientSecret'], properties: { activationId: { type: 'string' }, deviceId: { type: 'string' }, clientSecret: { type: 'string' } } } } },
        DeactivateRequest: { type: 'object', additionalProperties: false, required: ['productId', 'majorVersion', 'deviceId', 'clientSecret'], properties: { productId: { type: 'string' }, majorVersion: { type: 'integer' }, deviceId: { type: 'string' }, clientSecret: { type: 'string' } } },
      },
    },
  };
}
