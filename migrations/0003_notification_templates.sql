-- Additional transactional/security notification templates.
INSERT INTO email_templates (id, template_key, locale, category, subject, html_body, text_body) VALUES
('etp_portal_access', 'portal_access_granted', 'en', 'security',
 'You now have access to {{customerName}} in the RePassCloud customer portal',
 '<p>{{grantedBy}} gave you {{role}} access to <strong>{{customerName}}</strong> licences. Sign in with this email address at <a href="{{portalUrl}}">the customer portal</a> (we will email you a one-time link; there is no password).</p>',
 E'{{grantedBy}} gave you {{role}} access to {{customerName}} licences.\nSign in with this email address: {{portalUrl}}\n'),
('etp_admin_invited', 'admin_invited', 'en', 'security',
 'You have been invited to administer RePassCloud Licensing',
 '<p>You were invited as an administrator ({{roles}}). Request a sign-in link at <a href="{{adminUrl}}">{{adminUrl}}</a>. You must enrol an authenticator app on first sign-in. If you did not expect this, contact {{supportEmail}}.</p>',
 E'You were invited as an administrator ({{roles}}).\nRequest a sign-in link at {{adminUrl}} and enrol an authenticator app on first sign-in.\n'),
('etp_expiring', 'subscription_expiring', 'en', 'transactional',
 '{{productSummary}} licence expires on {{expiresAt}}',
 '<p>Licence {{licenseId}} for {{productSummary}} expires on {{expiresAt}} and will not renew automatically. Renew or manage billing in the <a href="{{portalUrl}}">customer portal</a>. Basic features keep working after expiry.</p>',
 E'Licence {{licenseId}} for {{productSummary}} expires on {{expiresAt}} and will not renew automatically.\nPortal: {{portalUrl}}\n');
