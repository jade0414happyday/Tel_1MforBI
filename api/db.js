/* eslint-env node */

const mysql = require("mysql2/promise");

function getCfg() {
  const host = process.env.TEL_DB_HOST || "127.0.0.1";
  const port = Number(process.env.TEL_DB_PORT || 3306);
  const user = process.env.TEL_DB_USER || "root";
  const pass = process.env.TEL_DB_PASS || "";
  const db   = process.env.TEL_DB_NAME || "tel_bi";
  return { host, port, user, pass, db };
}

async function openConnection() {
  const { host, port, user, pass, db } = getCfg();
  return mysql.createConnection({
    host,
    port,
    user,
    password: pass,
    database: db,
  });
}

async function ping() {
  const conn = await openConnection();
  try {
    const [r1] = await conn.query("SELECT 1 AS ok");
    const [r2] = await conn.query("SELECT VERSION() AS v, CURRENT_USER() AS u");
    return { ok: r1[0].ok, v: r2[0].v, u: r2[0].u };
  } finally {
    await conn.end();
  }
}

module.exports = { getCfg, openConnection, ping };
