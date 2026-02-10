/* eslint-env node */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const http = require("http");
const { openConnection } = require("./db");

const SERVICE = "tel-api";
const VERSION = "tel-api-profile-0.5";

const HOST = process.env.TEL_API_HOST || process.env.HOST || "127.0.0.1";
const PORT_RAW = process.env.TEL_API_PORT || process.env.PORT || "3001";
const PORT = Number.isFinite(Number(PORT_RAW)) ? Number(PORT_RAW) : 3001;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "600",
  });
  res.end(body);
}

function parseUrl(req) {
  const u = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  return { pathname: u.pathname, q: Object.fromEntries(u.searchParams.entries()) };
}

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function clampInt(x, def, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function quoteId(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

async function tableExists(conn, tableName) {
  const [rows] = await conn.execute(
    "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1",
    [tableName]
  );
  return rows.length > 0;
}

// FIX#1: 用 information_schema.columns，避免 SHOW COLUMNS 回來欄位鍵名不一致導致 null
async function getColumns(conn, tableName) {
  const [rows] = await conn.execute(
    "SELECT COLUMN_NAME AS col FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
    [tableName]
  );
  return rows
    .map((r) => r.col ?? r.COLUMN_NAME ?? r.column_name)
    .filter((x) => x != null && x !== "");
}

function pickColumn(cols, candidates) {
  const lower = new Map(cols.map((c) => [String(c).toLowerCase(), c]));
  for (const cand of candidates) {
    const hit = lower.get(String(cand).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function resolveTxnSource(conn) {
  if (await tableExists(conn, "v_fact_txn_pretty")) return "v_fact_txn_pretty";
  if (await tableExists(conn, "fact_txn")) return "fact_txn";
  return null;
}

async function dbPing() {
  const conn = await openConnection();
  try {
    const [r1] = await conn.query("SELECT 1 AS ok");
    const [r2] = await conn.query("SELECT VERSION() AS v, CURRENT_USER() AS u");
    return { ok: r1[0].ok, v: r2[0].v, u: r2[0].u };
  } finally {
    await conn.end();
  }
}

async function profileTxns(q) {
  const book = q.book;
  const bank_code = q.bank_code;
  const from = q.from;
  const to = q.to;

  if (!book || !bank_code || !isYmd(from) || !isYmd(to)) {
    return {
      status: 400,
      body: {
        error: "bad_request",
        message: "required: book, bank_code, from(YYYY-MM-DD), to(YYYY-MM-DD)",
        version: VERSION,
        query: { book, bank_code, from, to },
      },
    };
  }

  if (q.limit == null || q.limit === "") {
    return {
      status: 200,
      body: { ok: 1, version: "tel-api-echo-0.1", query: { book, bank_code, from, to } },
    };
  }

  const limit = clampInt(q.limit, 50, 1, 500);

  const conn = await openConnection();
  try {
    const table = await resolveTxnSource(conn);
    if (!table) {
      return {
        status: 503,
        body: {
          error: "no_source_table",
          message: "expected v_fact_txn_pretty or fact_txn",
          version: VERSION,
          query: { book, bank_code, from, to, limit },
        },
      };
    }

    const cols = await getColumns(conn, table);

    const dateCol = pickColumn(cols, ["txn_date", "日期", "date"]);
    // FIX#2: book 欄位候選加入 account_book
    const bookCol = pickColumn(cols, ["account_book", "book", "帳簿"]);
    const bankCol = pickColumn(cols, ["bank_code", "bankcode", "銀行代碼", "銀行"]);

    if (!dateCol || !bookCol || !bankCol) {
      return {
        status: 503,
        body: {
          error: "missing_required_column",
          message: "need recognized columns for date/book/bank_code",
          version: VERSION,
          source: { table, date_col: dateCol, book_col: bookCol, bank_col: bankCol },
          columns: cols,
        },
      };
    }

    // FIX#3: LIMIT 不用 placeholder，避免 mysqld_stmt_execute 參數錯誤
    const sql =
      `SELECT * ` +
      `FROM ${quoteId(table)} ` +
      `WHERE ${quoteId(dateCol)} >= ? AND ${quoteId(dateCol)} <= ? ` +
      `AND ${quoteId(bookCol)} = ? ` +
      `AND ${quoteId(bankCol)} = ? ` +
      `ORDER BY ${quoteId(dateCol)} ASC ` +
      `LIMIT ${limit}`;

    const [rows] = await conn.execute(sql, [from, to, book, bank_code]);

    return {
      status: 200,
      body: {
        ok: 1,
        version: VERSION,
        source: { table, date_col: dateCol, book_col: bookCol, bank_col: bankCol },
        query: { book, bank_code, from, to, limit },
        rows,
      },
    };
  } finally {
    await conn.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Max-Age": "600",
    });
    return res.end();
  }

  const { pathname, q } = parseUrl(req);

  try {
    if (req.method === "GET" && pathname === "/db/ping") {
      return sendJson(res, 200, await dbPing());
    }

    if (req.method === "GET" && pathname === "/profile/txns") {
      const out = await profileTxns(q);
      return sendJson(res, out.status, out.body);
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (e) {
    return sendJson(res, 503, {
      error: "server_error",
      message: e && e.message ? e.message : String(e),
      version: VERSION,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${SERVICE} ${VERSION} listening on http://${HOST}:${PORT}`);
});
