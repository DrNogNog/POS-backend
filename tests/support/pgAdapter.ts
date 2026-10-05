// TEST HARNESS ONLY: a minimal Prisma driver adapter over the `pg` package,
// so integration tests can run Prisma's query compiler (no native engine)
// against a scratch PostgreSQL. Production uses Prisma's normal engine.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
// @ts-expect-error - pg has no bundled types; this file is test-only
import pg from "pg";

const { Pool, types } = pg as Any;

// Column type ids Prisma expects (ColumnTypeEnum)
const CT = {
  Int32: 0, Int64: 1, Float: 2, Double: 3, Numeric: 4, Boolean: 5, Character: 6, Text: 7,
  Date: 8, Time: 9, DateTime: 10, Json: 11, Enum: 12, Bytes: 13, Uuid: 15,
  Int32Array: 64, Int64Array: 65, FloatArray: 66, DoubleArray: 67, NumericArray: 68,
  BooleanArray: 69, CharacterArray: 70, TextArray: 71, DateArray: 72, TimeArray: 73,
  DateTimeArray: 74, JsonArray: 75, EnumArray: 76, BytesArray: 77, UuidArray: 78,
};

const OID: Record<number, number> = {
  16: CT.Boolean, 17: CT.Bytes, 18: CT.Character, 20: CT.Int64, 21: CT.Int32, 23: CT.Int32,
  25: CT.Text, 26: CT.Int64, 114: CT.Json, 700: CT.Float, 701: CT.Double, 1042: CT.Text,
  1043: CT.Text, 1082: CT.Date, 1083: CT.Time, 1114: CT.DateTime, 1184: CT.DateTime,
  1700: CT.Numeric, 2950: CT.Uuid, 3802: CT.Json,
  1000: CT.BooleanArray, 1005: CT.Int32Array, 1007: CT.Int32Array, 1016: CT.Int64Array,
  1009: CT.TextArray, 1015: CT.TextArray, 1021: CT.FloatArray, 1022: CT.DoubleArray,
  1231: CT.NumericArray, 1115: CT.DateTimeArray, 1185: CT.DateTimeArray, 3807: CT.JsonArray,
};

// Return raw strings for values Prisma wants to parse itself.
const raw = (v: string) => v;
const ts = (v: string) => (v ? v.replace(" ", "T") + (/[+-]\d\d(:?\d\d)?$/.test(v) ? "" : "+00:00") : v);
const parsers: Record<number, (v: string) => unknown> = {
  1700: raw,
  20: raw,
  114: raw,
  3802: raw,
  1082: raw,
  1083: raw,
  1114: ts,
  1184: (v) => new Date(v).toISOString(),
};
const arrayOf = (fn: (v: string) => unknown) => (v: string) =>
  (types.arrayParser.create(v, fn) as Any).parse();

function getTypeParser(oid: number, format?: string) {
  if (parsers[oid]) return parsers[oid];
  if (oid === 1231) return arrayOf(raw);
  if (oid === 1115) return arrayOf(ts);
  if (oid === 3807 || oid === 199) return arrayOf(raw);
  if (oid === 1016) return arrayOf(raw);
  return types.getTypeParser(oid, format);
}

function columnType(oid: number): number {
  if (OID[oid] !== undefined) return OID[oid];
  return oid >= 10000 ? CT.Enum : CT.Text; // user-defined enums
}

function mapArg(arg: unknown, argType: Any): unknown {
  if (arg === null || arg === undefined) return null;
  if (Array.isArray(arg)) return arg.map((a) => mapArg(a, { ...argType, arity: "scalar" }));
  if (argType?.scalarType === "datetime" && typeof arg === "string") return arg;
  if (argType?.scalarType === "bytes" && typeof arg === "string") return Buffer.from(arg, "base64");
  if (arg instanceof Date) return arg.toISOString();
  return arg;
}

class Queryable {
  provider = "postgres" as const;
  adapterName = "@prisma/adapter-pg";
  constructor(protected client: Any) {}

  async queryRaw(q: Any) {
    const res = await this.performIO(q);
    return {
      columnNames: res.fields.map((f: Any) => f.name),
      columnTypes: res.fields.map((f: Any) => columnType(f.dataTypeID)),
      rows: res.rows,
    };
  }

  async executeRaw(q: Any) {
    const res = await this.performIO(q);
    return res.rowCount ?? 0;
  }

  protected async performIO(q: Any) {
    const values = q.args.map((a: unknown, i: number) => mapArg(a, q.argTypes?.[i]));
    try {
      return await this.client.query({ text: q.sql, values, rowMode: "array", types: { getTypeParser } });
    } catch (e: Any) {
      // Shape errors like the official adapter so Prisma maps P2002 etc.
      if (e && typeof e.code === "string") {
        throw Object.assign(new Error(e.message), {
          name: "DriverAdapterError",
          cause: { kind: "postgres", code: e.code, severity: e.severity, message: e.message, detail: e.detail, column: e.column, hint: e.hint, originalCode: e.code, originalMessage: e.message },
        });
      }
      throw e;
    }
  }
}

class PgTransaction extends Queryable {
  options = { usePhantomQuery: false };
  constructor(client: Any, private release: () => void) {
    super(client);
  }
  async commit() {
    this.release();
  }
  async rollback() {
    this.release();
  }
}

class PgAdapter extends Queryable {
  constructor(private pool: Any) {
    super(pool);
  }
  async executeScript(script: string) {
    await this.pool.query(script);
  }
  getConnectionInfo() {
    return { schemaName: "public", supportsRelationJoins: true };
  }
  async startTransaction(isolationLevel?: string) {
    const conn = await this.pool.connect();
    const tx = new PgTransaction(conn, () => conn.release());
    await tx.executeRaw({ sql: "BEGIN", args: [], argTypes: [] });
    if (isolationLevel) {
      await tx.executeRaw({ sql: `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`, args: [], argTypes: [] });
    }
    return tx;
  }
  async dispose() {
    await this.pool.end();
  }
}

export class TestPgAdapterFactory {
  provider = "postgres" as const;
  adapterName = "@prisma/adapter-pg";
  constructor(private connectionString: string) {}
  async connect() {
    return new PgAdapter(new Pool({ connectionString: this.connectionString, max: 5 }));
  }
}

export async function runSql(connectionString: string, sql: string) {
  const pool = new Pool({ connectionString });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}
