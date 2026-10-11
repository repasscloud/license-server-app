// The single catalogue of permissions. Roles grant them to admin users; API tokens carry a
// subset as scopes. No permission (scope) ever exposes decrypted private signing keys.

export const PERMISSIONS = {
  'products:read': 'Read products, majors, releases and edition policies',
  'products:write': 'Create/modify products, majors, releases, edition policies and offers',
  'prices:read': 'Read price versions and Stripe price mappings',
  'prices:write': 'Create, activate and archive price versions',
  'stripe:sync': 'Run Stripe catalogue synchronisation and drift checks',
  'customers:read': 'Read customers and organisation membership',
  'customers:write': 'Create/modify customers and membership',
  'entitlements:read': 'Read entitlements and policy snapshots',
  'entitlements:issue': 'Grant entitlements and amend entitlement policy',
  'entitlements:revoke': 'Revoke and un-revoke entitlements (high risk)',
  'licenses:read': 'Read licences and issuance history',
  'licenses:issue': 'Re-issue licences and rotate activation keys',
  'licenses:renew': 'Re-sign licences on demand',
  'activations:read': 'Read device activations',
  'activations:release': 'Release device activations',
  'transfers:write': 'Grant or reset device transfer allowances',
  'subscriptions:read': 'Read subscriptions and invoices',
  'subscriptions:manage': 'Reconcile subscriptions with Stripe',
  'checkouts:read': 'Read checkouts and purchases',
  'signing_keys:read_public': 'Read signing-key metadata and public keys',
  'signing_keys:manage': 'Generate, publish, trust, retire, rewrap signing keys (high risk; never exposes private keys)',
  'email:read': 'Read email outbox and delivery status',
  'email:retry': 'Retry failed or dead emails',
  'email:templates': 'Edit email templates',
  'webhooks:read': 'Read webhook events and jobs',
  'webhooks:reconcile': 'Reprocess webhook events, retry jobs and run reconciliation',
  'audit:read': 'Read the audit log',
  'tokens:manage': 'Create/revoke API tokens for service accounts and other admins (high risk)',
  'admins:manage': 'Manage administrators, roles and service accounts (high risk)',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const HIGH_RISK_SCOPES = new Set<string>(['signing_keys:manage', 'tokens:manage', 'admins:manage', 'entitlements:revoke']);
export const isPermission = (s: string): s is Permission => s in PERMISSIONS;
