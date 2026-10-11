// RESTRICTED import of an existing private signing key (e.g. migrating keys generated offline).
// The 32-byte private encoding (hex) is read from STDIN, never argv. The public key is derived
// from it, so a mismatched pair cannot be imported. Ordinary admins use key generation instead.
//
//   security find-generic-password -s repass-key-import -w | \
//     DATABASE_URL=… SIGNING_KEK_V1=… node scripts/import-signing-key.ts --key-id repass-ed25519-2026 --algorithm Ed25519

import { isSignatureAlgorithm } from '../src/crypto/algorithms.ts';
import { hexDecode } from '../src/lib/encoding.ts';
import { importSigningKey } from '../src/services/signing-keys.ts';
import { arg, operatorDeps, readSecretLine } from './lib/operator.ts';

const keyId = arg('key-id');
const algorithm = arg('algorithm');
if (!keyId || !algorithm || !isSignatureAlgorithm(algorithm)) {
  console.error('Usage: … | node scripts/import-signing-key.ts --key-id <id> --algorithm Ed25519|ECDSA-P256-SHA256|ML-DSA-65');
  process.exit(2);
}
const hex = await readSecretLine('Private key (64 hex chars): ');
const { sql, config } = operatorDeps();
try {
  const priv = hexDecode(hex);
  const k = await importSigningKey(sql, config.signingKeks, { type: 'system', id: 'import-cli', label: 'import-cli' }, { keyId, algorithm, privateKey: priv, origin: 'imported', notes: arg('notes') ?? '' });
  console.log(JSON.stringify({ keyId: k.keyId, algorithm: k.algorithm, publicKey: k.publicKey, fingerprint: k.fingerprint, status: k.status }, null, 2));
} finally {
  await sql.end();
}
