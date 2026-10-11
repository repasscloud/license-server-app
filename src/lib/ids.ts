// Identifier generation. Wire identifiers use [A-Za-z0-9_.-] (v1 brief §2).
// Format: <prefix>_<26 chars Crockford base32> = 48-bit ms timestamp + 80 random bits (ULID layout),
// sortable by creation time and unguessable.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[rnd[i]! & 31];
  return time + r;
}

export type IdPrefix =
  | 'prd' | 'pmj' | 'rel' | 'pep' | 'off' | 'ocp' | 'prc'
  | 'cus' | 'usr' | 'adm' | 'svc' | 'tok' | 'chl'
  | 'chk' | 'sub' | 'pur' | 'pul' | 'inv' | 'cin'
  | 'eps' | 'ent' | 'lic' | 'akey' | 'act' | 'kcp'
  | 'etp' | 'eml' | 'req';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export const WIRE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}
