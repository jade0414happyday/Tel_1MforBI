/* eslint-env node */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const mysql = require("mysql2/promise");

async function main() {
  const host = process.env.TEL_DB_HOST || "127.0.0.1";
  const port = Number(process.env.TEL_DB_PORT || 3306);
  const user = process.env.TEL_DB_USER || "root";
  const pass = process.env.TEL_DB_PASS || "";
  const db   = process.env.TEL_DB_NAME || "tel_bi";

  console.log("cfg", { host, port, user, db });

  const conn = await mysql.createConnection({ host, port, user, password: pass, database: db });

  // 1) SHOW COLUMNS（最關鍵）
  const [rows1] = await conn.query("SHOW COLUMNS FROM `v_fact_txn_pretty`");
  console.log("show_columns_row0_keys", rows1[0] ? Object.keys(rows1[0]) : null);
  console.log("show_columns_first5", rows1.slice(0, 5));

  // 2) 轉成欄位名清單（看應該取哪個 key）
  const names_guess = rows1.map(r => r.Field ?? r.field ?? r.COLUMN_NAME ?? r.column_name ?? Object.values(r)[0]);
  console.log("names_guess_first20", names_guess.slice(0, 20));

  // 3) information_schema 對照（確定是不是大小寫/欄位名問題）
  const [rows2] = await conn.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
    ["v_fact_txn_pretty"]
  );
  console.log("info_schema_row0_keys", rows2[0] ? Object.keys(rows2[0]) : null);
  console.log("info_schema_first20", rows2.slice(0, 20));

  await conn.end();
}

main().catch(e => {
  console.error("debug_cols_failed", e && e.message ? e.message : e);
  process.exit(1);
});
