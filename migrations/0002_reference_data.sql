-- Reference data required by every environment. Products, prices and customers are NOT seeded
-- here: they are business data created through the admin UI/API.

INSERT INTO license_protocols (id, name, license_format, activation_format, schema_version, max_signatures, description) VALUES
  ('repass-v1', 'RePass licence protocol v1', 'repass-license-v1', 'repass-activation-v1', 1, 8,
   'Binding contract from LICENSING-SERVER-BRIEF.md: perpetual for non-business editions; business requires maxActivations and device activation.');

-- Common edition labels. Labels only: behaviour lives in product_edition_policies.
INSERT INTO edition_definitions (id, wire_id, name, description) VALUES
  ('community',  'community',  'Community',  'Free/registration edition label'),
  ('education',  'education',  'Education',  'Institutional edition label'),
  ('business',   'business',   'Business',   'Commercial edition label'),
  ('enterprise', 'enterprise', 'Enterprise', 'Organisation-wide edition label');

INSERT INTO roles (id, name, description) VALUES
  ('superadmin',        'Super administrator', 'All permissions, including administrator and token management'),
  ('catalogue_manager', 'Catalogue manager',   'Products, majors, policies, offers, prices and Stripe sync'),
  ('support',           'Support agent',       'Customers, entitlements, licences, activations and transfers'),
  ('billing',           'Billing operator',    'Subscriptions, checkouts, webhooks and reconciliation'),
  ('key_custodian',     'Key custodian',       'Signing-key lifecycle and compatibility'),
  ('auditor',           'Auditor',             'Read-only access including audit log');

INSERT INTO role_permissions (role_id, permission)
SELECT 'superadmin', p FROM unnest(ARRAY[
  'products:read','products:write','prices:read','prices:write','stripe:sync',
  'customers:read','customers:write','entitlements:read','entitlements:issue','entitlements:revoke',
  'licenses:read','licenses:issue','licenses:renew','activations:read','activations:release','transfers:write',
  'subscriptions:read','subscriptions:manage','checkouts:read','signing_keys:read_public','signing_keys:manage',
  'email:read','email:retry','email:templates','webhooks:read','webhooks:reconcile','audit:read',
  'tokens:manage','admins:manage']) AS p;

INSERT INTO role_permissions (role_id, permission)
SELECT 'catalogue_manager', p FROM unnest(ARRAY[
  'products:read','products:write','prices:read','prices:write','stripe:sync','signing_keys:read_public','audit:read']) AS p;

INSERT INTO role_permissions (role_id, permission)
SELECT 'support', p FROM unnest(ARRAY[
  'products:read','prices:read','customers:read','customers:write','entitlements:read','entitlements:issue',
  'entitlements:revoke','licenses:read','licenses:issue','licenses:renew','activations:read','activations:release',
  'transfers:write','subscriptions:read','checkouts:read','email:read','email:retry']) AS p;

INSERT INTO role_permissions (role_id, permission)
SELECT 'billing', p FROM unnest(ARRAY[
  'products:read','prices:read','customers:read','entitlements:read','licenses:read','subscriptions:read',
  'subscriptions:manage','checkouts:read','webhooks:read','webhooks:reconcile','stripe:sync','email:read','email:retry']) AS p;

INSERT INTO role_permissions (role_id, permission)
SELECT 'key_custodian', p FROM unnest(ARRAY[
  'products:read','signing_keys:read_public','signing_keys:manage','audit:read']) AS p;

INSERT INTO role_permissions (role_id, permission)
SELECT 'auditor', p FROM unnest(ARRAY[
  'products:read','prices:read','customers:read','entitlements:read','licenses:read','activations:read',
  'subscriptions:read','checkouts:read','signing_keys:read_public','email:read','webhooks:read','audit:read']) AS p;

-- Default transactional templates. {{var}} placeholders are HTML-escaped on render; {{{var}}}
-- inserts pre-rendered, server-escaped HTML fragments only (never user input).
INSERT INTO email_templates (id, template_key, locale, category, subject, html_body, text_body) VALUES
('etp_purchase', 'purchase_confirmation', 'en', 'transactional',
 'Your {{productSummary}} licence is ready',
 '<p>Hello {{customerName}},</p><p>Thank you for your order <strong>{{purchaseId}}</strong>.</p>{{{itemsHtml}}}<p>Download licence files and manage your products in the <a href="{{portalUrl}}">customer portal</a>.</p><p>Support: <a href="mailto:{{supportEmail}}">{{supportEmail}}</a></p>',
 E'Hello {{customerName}},\n\nThank you for your order {{purchaseId}}.\n\n{{itemsText}}\n\nCustomer portal: {{portalUrl}}\nSupport: {{supportEmail}}\n'),
('etp_login_customer', 'customer_login', 'en', 'security',
 'Your sign-in link',
 '<p>Use this link to sign in to the RePassCloud customer portal. It expires in {{expiresMinutes}} minutes and can be used once.</p><p><a href="{{loginUrl}}">Sign in</a></p><p>If you did not request this, ignore this email.</p>',
 E'Sign in to the RePassCloud customer portal (expires in {{expiresMinutes}} minutes, single use):\n{{loginUrl}}\n\nIf you did not request this, ignore this email.\n'),
('etp_login_admin', 'admin_login', 'en', 'security',
 'Administrator sign-in link',
 '<p>Administrator sign-in link (expires in {{expiresMinutes}} minutes, single use). You will also need your authenticator code.</p><p><a href="{{loginUrl}}">Continue sign-in</a></p>',
 E'Administrator sign-in link (expires in {{expiresMinutes}} minutes, single use). You will also need your authenticator code.\n{{loginUrl}}\n'),
('etp_sub_renewed', 'subscription_renewed', 'en', 'transactional',
 '{{productSummary}} subscription renewed',
 '<p>Your subscription has been renewed. Licence {{licenseId}} is now valid until {{expiresAt}}.</p><p>Run your application''s renew command or download the updated licence from the <a href="{{portalUrl}}">portal</a>.</p>',
 E'Your subscription has been renewed. Licence {{licenseId}} is now valid until {{expiresAt}}.\nPortal: {{portalUrl}}\n'),
('etp_sub_payment_failed', 'subscription_payment_failed', 'en', 'transactional',
 'Payment failed for {{productSummary}}',
 '<p>We could not collect payment for your subscription. Your licence remains valid until {{expiresAt}}. Please update your payment method in the <a href="{{portalUrl}}">portal</a>.</p>',
 E'We could not collect payment for your subscription. Your licence remains valid until {{expiresAt}}.\nUpdate payment details: {{portalUrl}}\n'),
('etp_sub_cancelled', 'subscription_cancelled', 'en', 'transactional',
 '{{productSummary}} subscription cancelled',
 '<p>Your subscription has ended. Your licence stops working for paid features at {{expiresAt}}. Basic features remain available.</p>',
 E'Your subscription has ended. Your licence stops working for paid features at {{expiresAt}}.\n'),
('etp_device_released', 'device_released', 'en', 'security',
 'A device was released from licence {{licenseId}}',
 '<p>Activation {{activationId}} (device …{{deviceSuffix}}) was released by {{releasedBy}}. An offline device only learns of the release when it next renews.</p>',
 E'Activation {{activationId}} (device ...{{deviceSuffix}}) was released by {{releasedBy}}. An offline device only learns of the release when it next renews.\n'),
('etp_entitlement_revoked', 'entitlement_revoked', 'en', 'security',
 'Licence {{licenseId}} has been revoked',
 '<p>Licence {{licenseId}} has been revoked ({{reason}}). Installations will stop accepting it when they next contact the licensing server. Contact {{supportEmail}} if you think this is a mistake.</p>',
 E'Licence {{licenseId}} has been revoked ({{reason}}). Installations will stop accepting it when they next contact the licensing server.\nSupport: {{supportEmail}}\n'),
('etp_key_rotated', 'activation_key_rotated', 'en', 'security',
 'Activation key rotated for licence {{licenseId}}',
 '<p>The activation key for licence {{licenseId}} was rotated by {{rotatedBy}}. The old key no longer works; existing activations are unaffected.</p>',
 E'The activation key for licence {{licenseId}} was rotated by {{rotatedBy}}. The old key no longer works; existing activations are unaffected.\n');
