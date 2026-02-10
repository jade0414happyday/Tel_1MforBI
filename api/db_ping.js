/* eslint-env node */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const db = require("./db");

async function main() {
  const cfg = db.getCfg();
  console.log("cfg", {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    db: cfg.db,
    pass_len: cfg.pass.length,
    pass_tail_ws: /\s$/.test(cfg.pass),
    pass_has_ws: /\s/.test(cfg.pass),
  });

  const out = await db.ping();
  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.error("db_ping_failed", e.message);
  process.exit(1);
});
