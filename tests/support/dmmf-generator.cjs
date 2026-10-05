// TEST HARNESS ONLY: a tiny Prisma generator that saves the full DMMF
// (datamodel) to tests/support/dmmf.json so the harness can build tables.
const fs = require("fs");
const path = require("path");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    let result = null;
    if (msg.method === "getManifest") result = { manifest: { prettyName: "DMMF dump", defaultOutput: "." } };
    if (msg.method === "generate") {
      fs.writeFileSync(path.join(__dirname, "dmmf.json"), JSON.stringify(msg.params.dmmf.datamodel));
    }
    process.stderr.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
});
