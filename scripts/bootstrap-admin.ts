// One-time, operator-controlled creation of the first super administrator. There is NO web
// setup endpoint. Enrols TOTP offline so the very first login already requires MFA.
//
//   DATABASE_URL=… APP_DATA_KEY_V1=… node scripts/bootstrap-admin.ts --email you@repasscloud.com --name "Your Name"
//
// Prints an otpauth:// URI ONCE (add it to your authenticator), then sign in at /admin/login.
// Refuses to run when an enrolled super administrator already exists unless --additional.

import { appDataAad, sealCompact } from '../src/crypto/aead.ts';
import { newId } from '../src/lib/ids.ts';
import { newTotpSecret, otpauthUri } from '../src/auth/totp.ts';
import { arg, flag, operatorDeps } from './lib/operator.ts';

const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim() || 'Administrator';
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node scripts/bootstrap-admin.ts --email <email> [--name <name>] [--additional]');
  process.exit(2);
}
const { sql, config } = operatorDeps();
try {
  const existing = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_users a JOIN admin_user_roles r ON r.admin_user_id = a.id WHERE r.role_id = 'superadmin' AND a.status = 'active'`;
  if (existing[0]!.n > 0 && !flag('additional')) {
    console.error('A super administrator already exists. Use the admin UI/API to invite more, or pass --additional deliberately.');
    process.exit(1);
  }
  const id = newId('adm');
  const secret = newTotpSecret();
  const sealed = await sealCompact(config.appDataKeys, secret, appDataAad('admin-totp', id));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO admin_users (id, email, display_name, totp_secret_ciphertext, totp_key_version, totp_enrolled_at)
             VALUES (${id}, ${email}, ${name}, ${sealed.blob}, ${sealed.keyVersion}, now())`;
    await tx`INSERT INTO admin_user_roles (admin_user_id, role_id, granted_by) VALUES (${id}, 'superadmin', 'bootstrap-cli')`;
    await tx`INSERT INTO audit_events (actor_type, actor_id, action, resource_type, resource_id, outcome, detail)
             VALUES ('system', 'bootstrap-cli', 'admin.bootstrapped', 'admin_user', ${id}, 'success', '{}')`;
  });
  console.error(`Created super administrator ${email} (${id}).`);
  console.error('Add this to your authenticator app NOW. It will not be shown again:');
  console.log(otpauthUri(secret, email));
} finally {
  await sql.end();
}
