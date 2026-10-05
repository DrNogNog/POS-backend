// TEST HARNESS ONLY: builds CREATE TABLE statements from the Prisma schema so
// the tests can run against a scratch PostgreSQL database without Prisma's
// migration engine. Real databases are created with `prisma migrate`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function ddlFromDmmf(datamodel: Any): string {
  const out: string[] = [];
  for (const e of datamodel.enums) {
    out.push(`CREATE TYPE "${e.name}" AS ENUM (${e.values.map((v: Any) => `'${v.name}'`).join(", ")});`);
  }
  const fks: string[] = [];
  for (const m of datamodel.models) {
    const table = m.dbName || m.name;
    const cols: string[] = [];
    for (const f of m.fields) {
      if (f.kind === "object") {
        if (f.relationFromFields?.length) {
          const target = datamodel.models.find((x: Any) => x.name === f.type);
          const onDelete = (f.relationOnDelete || (f.isRequired ? "Restrict" : "SetNull"))
            .replace("SetNull", "SET NULL")
            .replace("NoAction", "NO ACTION")
            .toUpperCase();
          fks.push(
            `ALTER TABLE "${table}" ADD FOREIGN KEY (${f.relationFromFields.map((c: string) => `"${c}"`).join(",")}) REFERENCES "${
              target.dbName || target.name
            }"(${f.relationToFields.map((c: string) => `"${c}"`).join(",")}) ON DELETE ${onDelete} ON UPDATE CASCADE;`
          );
        }
        continue;
      }
      let type: string;
      const isAuto = f.default && typeof f.default === "object" && f.default.name === "autoincrement";
      if (f.kind === "enum") type = `"${f.type}"`;
      else if (f.type === "Int") type = isAuto ? "SERIAL" : "INTEGER";
      else if (f.type === "String") type = "TEXT";
      else if (f.type === "Boolean") type = "BOOLEAN";
      else if (f.type === "DateTime") type = "TIMESTAMP(3)";
      else if (f.type === "Json") type = "JSONB";
      else if (f.type === "Float") type = "DOUBLE PRECISION";
      else if (f.type === "Bytes") type = "BYTEA";
      else if (f.type === "Decimal") {
        const args = f.nativeType?.[1] ?? ["65", "30"];
        type = `DECIMAL(${args.join(",")})`;
      } else throw new Error(`Unsupported type ${f.type}`);
      if (f.isList) type += "[]";
      let col = `"${f.name}" ${type}`;
      if (f.default !== undefined && !isAuto) {
        const d = f.default;
        if (typeof d === "object" && !Array.isArray(d) && d.name === "now") col += " DEFAULT CURRENT_TIMESTAMP";
        else if (typeof d === "string") col += f.kind === "enum" ? ` DEFAULT '${d}'` : ` DEFAULT '${d.replace(/'/g, "''")}'`;
        else if (typeof d === "number" || typeof d === "boolean") col += ` DEFAULT ${d}`;
      }
      if (f.isRequired || f.isList) col += f.isList ? "" : " NOT NULL";
      cols.push(col);
    }
    const pk = m.primaryKey?.fields ?? m.fields.filter((f: Any) => f.isId).map((f: Any) => f.name);
    cols.push(`PRIMARY KEY (${pk.map((c: string) => `"${c}"`).join(",")})`);
    for (const f of m.fields) if (f.isUnique) cols.push(`UNIQUE ("${f.name}")`);
    for (const u of m.uniqueFields ?? []) cols.push(`UNIQUE (${u.map((c: string) => `"${c}"`).join(",")})`);
    out.push(`CREATE TABLE "${table}" (\n  ${cols.join(",\n  ")}\n);`);
  }
  return [...out, ...fks].join("\n");
}
