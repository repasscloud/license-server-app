// CI secret scan over tracked files. Fails on anything that looks like a live credential or
// private key. Public test vectors and documented placeholders are allowlisted explicitly.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['Stripe live secret key', /\b(sk|rk)_live_[A-Za-z0-9]{10,}/],
  ['Stripe test secret key', /\b(sk|rk)_test_[A-Za-z0-9]{20,}/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{24,}/],
  ['MailerSend token', /\bmlsn\.[A-Za-z0-9]{40,}/],
  ['RePass API token', /\brpl_(pat|svc)_[0-9A-HJKMNP-TV-Z]{16}_[A-Za-z0-9_-]{43}\b/],
  ['PEM private key', /-----BEGIN (EC |RSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['Postgres URL with password', /postgres(ql)?:\/\/[^:\s/]+:(?!\$\{|<|password|PASSWORD|test_only|ci_only|devonly)[^@\s]{6,}@/],
  ['Cloudflare API token', /\bCLOUDFLARE_API_TOKEN\s*=\s*[A-Za-z0-9_-]{30,}/],
];
const ALLOW = [/^tests\/fixtures\//, /^docs\/requirements\/upstream\//, /^package-lock\.json$/];
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !ALLOW.some((a) => a.test(f)));
const findings = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) findings.push(`${f}: ${name} (${m[0].slice(0, 12)}…)`);
  }
}
if (findings.length) {
  console.error('Possible secrets found:\n' + findings.join('\n'));
  process.exit(1);
}
console.log(`secret scan: ${files.length} tracked files clean`);
