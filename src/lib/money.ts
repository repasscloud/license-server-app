// Display formatting for integer minor units. Never used for arithmetic.

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export const currencyDigits = (currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2);

/** "1,234.50 AUD" (JPY and other zero-decimal currencies have no fraction). */
export function money(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const neg = minor < 0;
  const [whole, frac] = (Math.abs(minor) / 10 ** digits).toFixed(digits).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''} ${currency.toUpperCase()}`;
}
