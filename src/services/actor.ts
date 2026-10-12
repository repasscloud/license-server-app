// The identity on whose behalf a service call runs. Every service mutation takes an Actor so
// that authorisation and audit are uniform across the admin UI, the admin API, the customer
// portal, machines, webhooks and jobs.

import { forbidden } from '../lib/errors.ts';

export type ActorType = 'admin' | 'api_token' | 'customer' | 'device' | 'stripe' | 'mailersend' | 'system';

export interface Actor {
  type: ActorType;
  id: string | null;
  /** Human-readable label for audit/UI (never a secret). */
  label: string;
  permissions?: ReadonlySet<string>;
  /** For admin users: when the session last completed MFA (step-up checks). */
  mfaAt?: Date | null;
  /** For api_token actors: the owning admin user or service account. */
  principalId?: string;
  requestId?: string;
  ipHash?: string;
}

export function requirePermission(actor: Actor, permission: string): void {
  if (actor.type === 'system' || actor.type === 'stripe') return;
  if ((actor.type !== 'admin' && actor.type !== 'api_token') || !actor.permissions?.has(permission)) {
    throw forbidden(`Missing permission ${permission}`);
  }
}

export const HIGH_RISK_PERMISSIONS = new Set(['signing_keys:manage', 'admins:manage', 'tokens:manage', 'entitlements:revoke']);
const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

/**
 * High-risk operations from a browser session require MFA completed within the last 15 minutes.
 * API tokens carry the scope explicitly (issued by an MFA-authenticated admin) and are audited.
 */
export function requireHighRisk(actor: Actor, permission: string, now = new Date()): void {
  requirePermission(actor, permission);
  if (actor.type === 'admin') {
    if (!actor.mfaAt || now.getTime() - actor.mfaAt.getTime() > STEP_UP_WINDOW_MS) {
      throw forbidden('This action requires re-authentication with your authenticator code (step-up)');
    }
  }
}

export const systemActor = (label = 'system', requestId?: string): Actor => ({ type: 'system', id: null, label, requestId });
