// IPv4/IPv6 CIDR matching for API-token source restrictions.

function parseV4(ip: string): bigint | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0n;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    n = (n << 8n) | BigInt(x);
  }
  return n;
}

function parseV6(ip: string): bigint | null {
  if (ip.includes('.')) {
    // IPv4-mapped/embedded suffix
    const idx = ip.lastIndexOf(':');
    const v4 = parseV4(ip.slice(idx + 1));
    if (v4 === null) return null;
    const head = parseV6(ip.slice(0, idx + 1) + '0:0');
    return head === null ? null : (head & ~0xffffffffn) | v4;
  }
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...right];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function parseIp(ip: string): { v: 4 | 6; n: bigint } | null {
  const v4 = parseV4(ip);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(ip);
  return v6 === null ? null : { v: 6, n: v6 };
}

export function isValidCidr(cidr: string): boolean {
  const [ip, bits] = cidr.split('/');
  const p = ip ? parseIp(ip) : null;
  if (!p || bits === undefined || !/^\d+$/.test(bits)) return false;
  return Number(bits) <= (p.v === 4 ? 32 : 128);
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const a = parseIp(ip);
  const b = base ? parseIp(base) : null;
  if (!a || !b || a.v !== b.v || bitsStr === undefined) return false;
  const width = a.v === 4 ? 32n : 128n;
  const bits = BigInt(bitsStr);
  if (bits > width) return false;
  if (bits === 0n) return true;
  const mask = ((1n << bits) - 1n) << (width - bits);
  return (a.n & mask) === (b.n & mask);
}
