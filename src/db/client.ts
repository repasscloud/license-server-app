// PostgreSQL access via postgres.js. In Workers the connection goes through Hyperdrive
// (transaction-mode pooling). Rules that keep this correct and cheap:
//   - prepare: true (Hyperdrive supports named prepared statements; prepare:false can hang)
//   - fetch_types: false (no array-type discovery round-trip; built-in arrays still parse)
//   - Hyperdrive query CACHING MUST BE DISABLED for this application: licensing reads such as
//     revocation, sessions and rate limits must never be served stale.
//   - all multi-statement invariants run inside sql.begin() so they share one connection.

import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | Tx;

const int8 = {
  to: 20,
  from: [20],
  serialize: (x: number | bigint) => x.toString(),
  parse: (x: string) => {
    const n = Number(x);
    if (!Number.isSafeInteger(n)) throw new Error('int8 value exceeds safe integer range');
    return n;
  },
};

/** Parse a PostgreSQL text[] literal such as {a,"b c",NULL}. One-dimensional only. */
export function parseTextArray(lit: string): (string | null)[] {
  if (lit === '{}') return [];
  if (lit[0] !== '{' || lit[lit.length - 1] !== '}') throw new Error('not an array literal');
  const out: (string | null)[] = [];
  let i = 1;
  while (i < lit.length - 1) {
    if (lit[i] === '"') {
      let v = '';
      i++;
      while (lit[i] !== '"') {
        if (lit[i] === '\\') i++;
        v += lit[i++];
      }
      i++;
      out.push(v);
    } else {
      let j = i;
      while (lit[j] !== ',' && j < lit.length - 1) j++;
      const raw = lit.slice(i, j);
      out.push(raw === 'NULL' ? null : raw);
      i = j;
    }
    if (lit[i] === ',') i++;
  }
  return out;
}

// text[] (oid 1009) results. With fetch_types:false postgres.js does not parse arrays, so we
// register the one array type we read. Array PARAMETERS are never bound directly: callers pass
// JSON and expand it in SQL with textArray()/jsonb_array_elements_text (see below).
const textArrayType = {
  to: 25,
  from: [1009],
  serialize: (x: unknown) => String(x),
  parse: parseTextArray,
};

export function createSql(connectionString: string, opts: { max?: number } = {}): Sql {
  return postgres(connectionString, {
    max: opts.max ?? 5,
    fetch_types: false,
    prepare: true,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    types: { int8, textArrayType } as never,
  }) as unknown as Sql;
}

/** True for PostgreSQL unique-violation errors, optionally on a specific constraint. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint_name?: string };
  return err?.code === '23505' && (constraint === undefined || err.constraint_name === constraint);
}

export function toBytes(v: unknown): Uint8Array<ArrayBuffer> {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  throw new Error('expected bytea');
}

/** SQL fragment producing a text[] from a JS string array, without driver array typing. */
export function textArray(db: Db, values: readonly string[]) {
  return db`(SELECT coalesce(array_agg(x ORDER BY o), '{}'::text[]) FROM jsonb_array_elements_text(${db.json(values as never)}::jsonb) WITH ORDINALITY AS t(x, o))`;
}
