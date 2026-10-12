// RFC 3339 UTC timestamps with whole seconds and a trailing Z (v1 brief §2).

export function truncateToSecond(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

export function rfc3339(d: Date): string {
  return truncateToSecond(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addInterval(d: Date, unit: 'day' | 'week' | 'month' | 'year', count: number): Date {
  const r = new Date(d.getTime());
  switch (unit) {
    case 'day':
      r.setUTCDate(r.getUTCDate() + count);
      return r;
    case 'week':
      r.setUTCDate(r.getUTCDate() + 7 * count);
      return r;
    case 'month': {
      // Clamp to the last day of the target month (Jan 31 + 1 month = Feb 28/29), like Stripe.
      const day = r.getUTCDate();
      r.setUTCDate(1);
      r.setUTCMonth(r.getUTCMonth() + count);
      const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
      r.setUTCDate(Math.min(day, last));
      return r;
    }
    case 'year': {
      const m = r.getUTCMonth();
      r.setUTCFullYear(r.getUTCFullYear() + count);
      if (r.getUTCMonth() !== m) r.setUTCDate(0); // Feb 29 -> Feb 28
      return r;
    }
  }
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function fromUnixSeconds(s: number | null | undefined): Date | null {
  return typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000) : null;
}
