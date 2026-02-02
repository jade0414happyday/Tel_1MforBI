/* eslint-env node */

// api/server.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const http = require("http");
const os = require("os");

const SERVICE = "tel-api";
const VERSION = "0.3.0";

const HOST = process.env.TEL_API_HOST || process.env.HOST || "127.0.0.1";
const PORT_RAW = process.env.TEL_API_PORT || process.env.PORT || "3001";
const PORT_NUM = Number(PORT_RAW);
const PORT = Number.isFinite(PORT_NUM) ? PORT_NUM : 3001;

let mysql = null;
try {
  mysql = require("mysql2/promise");
} catch (e) {}

const startAt = Date.now();
let listenInfo = { host: HOST, port: null };

let shuttingDown = false;

// -------------------------
// small utils
// -------------------------
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toYmd(v) {
  if (!v) return null;

  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toYm(v) {
  const ymd = toYmd(v);
  if (!ymd) return null;
  return ymd.slice(0, 7); // YYYY-MM
}

function monthCountInclusive(fromYmd, toYmd2) {
  // from/to 已驗證 YYYY-MM-DD
  const a = new Date(`${fromYmd}T00:00:00Z`);
  const b = new Date(`${toYmd2}T00:00:00Z`);
  const ay = a.getUTCFullYear(),
    am = a.getUTCMonth();
  const by = b.getUTCFullYear(),
    bm = b.getUTCMonth();
  return (by - ay) * 12 + (bm - am) + 1; // inclusive
}

function safeIdent(name) {
  if (!name) return null;
  if (!/^[A-Za-z0-9_]+$/.test(name)) return null;
  return name;
}

function sendJSON(res, statusCode, payload) {
  if (!res || res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function makeBasePayload() {
  return {
    service: SERVICE,
    version: VERSION,
    now: new Date().toISOString(),
    listen: listenInfo,
  };
}

function safeUrl(req) {
  const raw = typeof req.url === "string" ? req.url : "/";
  return new URL(raw, `http://${HOST}:${listenInfo.port || PORT}`);
}

function shouldRejectWhenShuttingDown(res) {
  if (!shuttingDown) return false;
  sendJSON(res, 503, {
    ok: false,
    success: false,
    ...makeBasePayload(),
    error_code: "shutting_down",
    error: "shutting_down",
  });
  return true;
}

// -------------------------
// DB pool
// -------------------------
function buildPool() {
  const host = process.env.TEL_DB_HOST;
  const user = process.env.TEL_DB_USER;
  const database = process.env.TEL_DB_NAME;

  if (!host || !user || !database) return null;
  if (!mysql) return { __missingDriver: true };

  return mysql.createPool({
    host,
    port: Number(process.env.TEL_DB_PORT || 3306),
    user,
    password: process.env.TEL_DB_PASSWORD || "",
    database,
    waitForConnections: true,
    connectionLimit: clampInt(process.env.TEL_DB_POOL_SIZE, 1, 50, 10),
    queueLimit: 0,
    timezone: "Z",
  });
}

const pool = buildPool();

function dbReadyOrExplain(res) {
  if (!pool) {
    sendJSON(res, 500, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "db_not_configured",
      error: "db_not_configured",
    });
    return false;
  }
  if (pool.__missingDriver) {
    sendJSON(res, 500, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "mysql2_not_installed",
      error: "mysql2_not_installed",
    });
    return false;
  }
  return true;
}

async function dbPing() {
  if (!pool) return { ok: false, reason: "db_not_configured" };
  if (pool.__missingDriver) return { ok: false, reason: "mysql2_not_installed" };

  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: "db_error", message: String(e.message || e) };
  }
}

async function queryTxns({ book, bank_code, from, to, limit, offset }) {
  if (!pool) return { ok: false, reason: "db_not_configured" };
  if (pool.__missingDriver) return { ok: false, reason: "mysql2_not_installed" };

  const viewName = safeIdent(process.env.TEL_TXN_VIEW || "v_fact_txn_pretty");
  const tableName = safeIdent(process.env.TEL_TXN_TABLE || "fact_txn");

  const lim = clampInt(limit, 1, 500, 50);
  const off = clampInt(offset, 0, 1000000000, 0);

  const where = [];
  const params = [];

  if (book) {
    where.push(`account_book = ?`);
    params.push(String(book));
  }
  if (bank_code) {
    where.push(`bank_code = ?`);
    params.push(String(bank_code));
  }
  if (from) {
    where.push(`txn_date >= ?`);
    params.push(String(from));
  }
  if (to) {
    where.push(`txn_date <= ?`);
    params.push(String(to));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sqls = [];
  if (viewName)
    sqls.push(
      `SELECT * FROM ${viewName} ${whereSql} ORDER BY txn_date DESC, txn_id DESC LIMIT ? OFFSET ?`
    );
  if (viewName) sqls.push(`SELECT * FROM ${viewName} ${whereSql} LIMIT ? OFFSET ?`);
  if (tableName)
    sqls.push(
      `SELECT * FROM ${tableName} ${whereSql} ORDER BY txn_date DESC, txn_id DESC LIMIT ? OFFSET ?`
    );
  if (tableName) sqls.push(`SELECT * FROM ${tableName} ${whereSql} LIMIT ? OFFSET ?`);

  let lastErr = null;
  for (const sql of sqls) {
    try {
      const [rows] = await pool.query(sql, [...params, lim, off]);
      return {
        ok: true,
        limit: lim,
        offset: off,
        rows,
        source: sql.includes(viewName) ? "view" : "table",
      };
    } catch (e) {
      lastErr = e;
    }
  }

  return {
    ok: false,
    reason: "query_failed",
    message: String(lastErr && (lastErr.message || lastErr)),
  };
}

async function queryTxnsTotal({ book, bank_code, from, to }) {
  if (!pool) return { ok: false, reason: "db_not_configured" };
  if (pool.__missingDriver) return { ok: false, reason: "mysql2_not_installed" };

  const viewName = safeIdent(process.env.TEL_TXN_VIEW || "v_fact_txn_pretty");
  const tableName = safeIdent(process.env.TEL_TXN_TABLE || "fact_txn");

  const where = [];
  const params = [];

  if (book) {
    where.push(`account_book = ?`);
    params.push(String(book));
  }
  if (bank_code) {
    where.push(`bank_code = ?`);
    params.push(String(bank_code));
  }
  if (from) {
    where.push(`txn_date >= ?`);
    params.push(String(from));
  }
  if (to) {
    where.push(`txn_date <= ?`);
    params.push(String(to));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sqls = [];
  if (viewName) sqls.push(`SELECT COUNT(*) AS total FROM ${viewName} ${whereSql}`);
  if (tableName) sqls.push(`SELECT COUNT(*) AS total FROM ${tableName} ${whereSql}`);

  let lastErr = null;
  for (const sql of sqls) {
    try {
      const [rows] = await pool.query(sql, params);
      const total =
        rows && rows[0] && rows[0].total != null ? Number(rows[0].total) : 0;
      return { ok: true, total, source: sql.includes(viewName) ? "view" : "table" };
    } catch (e) {
      lastErr = e;
    }
  }

  return {
    ok: false,
    reason: "query_failed",
    message: String(lastErr && (lastErr.message || lastErr)),
  };
}

// -------------------------
// routes (keep each handler small)
// -------------------------
async function routeRoot(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/") return false;

  sendJSON(res, 200, {
    ok: true,
    success: true,
    ...makeBasePayload(),
    routes: [
      "/health",
      "/health?db=1",
      "/api/v1/health",
      "/db/ping",
      "/api/v1/txns?book=A&bank_code=SINOPAC&from=2018-08-21&to=2026-06-21&limit=50&offset=0",

      "/profile/life-liquidity?book=A&bank_code=SINOPAC&from=2021-01-01&to=2022-12-31",
      "/profile/life-liquidity/missing-months?book=A&bank_code=SINOPAC&from=2021-01-01&to=2022-12-31",
      "/profile/life-liquidity/kpi?book=A&bank_code=SINOPAC&from=2021-01-01&to=2022-12-31",

      "/api/v1/health/missing-months?book=A&bank_code=SINOPAC&from=2021-01-01&to=2022-12-31",
      "/api/v1/health/kpi?book=A&bank_code=SINOPAC&from=2021-01-01&to=2022-12-31",
    ],
  });
  return true;
}

async function routeHealth(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/health") return false;

  const wantDb = url.searchParams.get("db") === "1";
  const db = wantDb ? await dbPing() : null;

  sendJSON(res, 200, {
    ok: true,
    success: true,
    ...makeBasePayload(),
    uptime_sec: Math.floor((Date.now() - startAt) / 1000),
    host: os.hostname(),
    db: wantDb ? (db.ok ? "ok" : db.reason) : "skipped",
  });
  return true;
}

// P1: /api/v1/health（符合你明天驗收要求：200 + ok:true）
async function routeApiV1Health(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/v1/health") return false;

  sendJSON(res, 200, {
    ok: true,
    service: SERVICE,
    version: VERSION,
    host: listenInfo.host,
    port: listenInfo.port,
    ts: new Date().toISOString(),
  });
  return true;
}

// P3: /profile/life-liquidity（stub，先不碰 DB）
async function routeProfileLifeLiquidityStub(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/profile/life-liquidity") return false;

  const book = String(url.searchParams.get("book") || "").trim();
  const bankCode = String(url.searchParams.get("bank_code") || "").trim();
  const from = String(url.searchParams.get("from") || "").trim();
  const to = String(url.searchParams.get("to") || "").trim();

  sendJSON(res, 200, {
    ok: true,
    route: "/profile/life-liquidity",
    query: { book, bank_code: bankCode, from, to },
    data: {
      life_liquidity: 0,
      inflow: 0,
      outflow: 0,
      net: 0,
    },
    ts: new Date().toISOString(),
  });
  return true;
}

async function routeDbPing(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/db/ping") return false;

  const ping = await dbPing();
  sendJSON(res, ping.ok ? 200 : 503, {
    ok: ping.ok,
    success: ping.ok,
    ...makeBasePayload(),
    ...ping,
    error_code: ping.ok ? null : ping.reason,
  });
  return true;
}

async function routeTxns(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/v1/txns") return false;

  if (!dbReadyOrExplain(res)) return true;

  const book = String(url.searchParams.get("book") || "").trim();
  const bankCode = String(url.searchParams.get("bank_code") || "").trim();
  const from = String(url.searchParams.get("from") || "").trim();
  const to = String(url.searchParams.get("to") || "").trim();

  if ((from && !isYmd(from)) || (to && !isYmd(to))) {
    sendJSON(res, 400, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "bad_request",
      error: "from/to must be YYYY-MM-DD",
    });
    return true;
  }
  if (from && to && from > to) {
    sendJSON(res, 400, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "bad_request",
      error: "from must be <= to",
    });
    return true;
  }

  const limitRaw = url.searchParams.get("limit") || "50";
  const offsetRaw = url.searchParams.get("offset") || "0";

  const limitNum = Math.max(1, Math.min(500, Number(limitRaw) || 50));
  const offsetNum = Math.max(0, Number(offsetRaw) || 0);

  const data = await queryTxns({
    book,
    bank_code: bankCode,
    from,
    to,
    limit: limitNum,
    offset: offsetNum,
  });

  if (data && data.ok) {
    const t = await queryTxnsTotal({ book, bank_code: bankCode, from, to });
    data.total = t && t.ok ? t.total : 0;
  } else if (data) {
    data.total = 0;
  }

  if (data) {
    data.limit = limitNum;
    data.offset = offsetNum;
  }

  const rows2 =
    data.ok && Array.isArray(data.rows)
      ? data.rows.map((r) => ({ ...r, txn_date: toYmd(r.txn_date) }))
      : data.rows;

  sendJSON(res, data.ok ? 200 : 503, {
    ok: data.ok,
    success: data.ok,
    ...makeBasePayload(),
    ...data,
    error_code: data.ok ? null : data.reason,
    rows: rows2,
  });
  return true;
}

async function routeMissingMonths(req, res, url) {
  if (req.method !== "GET") return false;

  const p = url.pathname;
  if (p !== "/profile/life-liquidity/missing-months" && p !== "/api/v1/health/missing-months")
    return false;

  if (!dbReadyOrExplain(res)) return true;

  const book = String(url.searchParams.get("book") || "A").trim();
  const bankCode = String(url.searchParams.get("bank_code") || "SINOPAC").trim();
  const from = String(url.searchParams.get("from") || "2021-01-01").trim();
  const to = String(url.searchParams.get("to") || "2022-12-31").trim();

  if (!isYmd(from) || !isYmd(to)) {
    sendJSON(res, 400, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "bad_request",
      error: "from/to must be YYYY-MM-DD",
    });
    return true;
  }
  if (from > to) {
    sendJSON(res, 400, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "bad_request",
      error: "from must be <= to",
    });
    return true;
  }

  try {
    // 穩固地基：一律用 utf8mb4_bin 做等號比對，避開任意 collation 混用
    const sql = `
      WITH RECURSIVE
      bounds AS (
        SELECT
          DATE_SUB(DATE(?), INTERVAL DAYOFMONTH(DATE(?)) - 1 DAY) AS start_m,
          DATE_SUB(DATE(?), INTERVAL DAYOFMONTH(DATE(?)) - 1 DAY) AS end_m
      ),
      months AS (
        SELECT start_m AS m FROM bounds
        UNION ALL
        SELECT DATE_ADD(m, INTERVAL 1 MONTH)
        FROM months
        JOIN bounds ON 1=1
        WHERE m < bounds.end_m
      ),
      have AS (
        SELECT DISTINCT txn_month
        FROM v_profile_life_liquidity
        JOIN bounds ON 1=1
        WHERE CONVERT(book USING utf8mb4) COLLATE utf8mb4_bin
              = CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin
          AND CONVERT(bank_code USING utf8mb4) COLLATE utf8mb4_bin
              = CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin
          AND txn_month BETWEEN bounds.start_m AND bounds.end_m
      )
      SELECT months.m AS missing_txn_month
      FROM months
      LEFT JOIN have ON have.txn_month = months.m
      WHERE have.txn_month IS NULL
      ORDER BY months.m
    `;

    const params = [from, from, to, to, book, bankCode];
    const [rows] = await pool.query(sql, params);

    const totalMonths = monthCountInclusive(from, to);

    const missingMonths = Array.isArray(rows)
      ? rows.map((r) => toYm(r.missing_txn_month)).filter(Boolean)
      : [];

    const missingCnt = missingMonths.length;
    const effective = Math.max(0, totalMonths - missingCnt);
    const coverage = totalMonths > 0 ? effective / totalMonths : 0;

    // 給前端一致結構：rows + meta（同時保留舊欄位，避免你別處用到）
    sendJSON(res, 200, {
      ok: true,
      success: true,
      ...makeBasePayload(),

      // echo query
      book,
      bank_code: bankCode,
      from,
      to,

      // new: meta/rows (frontend-friendly)
      meta: {
        book,
        bank_code: bankCode,
        from,
        to,
        total_months: totalMonths,
        missing_cnt: missingCnt,
        effective_months: effective,
        coverage,
      },
      rows: Array.isArray(rows)
        ? rows
            .map((r) => ({ missing_txn_month: toYm(r.missing_txn_month) }))
            .filter((r) => r.missing_txn_month)
        : [],

      // legacy fields (keep)
      total_months: totalMonths,
      effective_months: { have: effective, total: totalMonths },
      missing_cnt: missingCnt,
      missing_months: missingMonths,
      coverage,

      // raw rows (debug)
      rows_raw: rows,
    });
    return true;
  } catch (e) {
    sendJSON(res, 500, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "db_error",
      error: "db_error",
      message: String((e && e.message) || e),
    });
    return true;
  }
}

async function routeKpi(req, res, url) {
  if (req.method !== "GET") return false;

  const p = url.pathname;
  if (p !== "/profile/life-liquidity/kpi" && p !== "/api/v1/health/kpi") return false;

  if (!dbReadyOrExplain(res)) return true;

  const book = String(url.searchParams.get("book") || "A").trim();
  const bankCode = String(url.searchParams.get("bank_code") || "SINOPAC").trim();
  const from = String(url.searchParams.get("from") || "2021-01-01").trim();
  const to = String(url.searchParams.get("to") || "2022-12-31").trim();

  if (!isYmd(from) || !isYmd(to)) {
    sendJSON(res, 400, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "bad_request",
      error: "from/to must be YYYY-MM-DD",
    });
    return true;
  }
  if (from > to) {
    sendJSON(res, 400, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "bad_request",
      error: "from must be <= to",
    });
    return true;
  }

  // 先做 mock，先把資料流打通（你選 B 的第一步）
  const evoPct = 0.15; // +15%

  sendJSON(res, 200, {
    ok: true,
    success: true,
    ...makeBasePayload(),

    meta: {
      book,
      bank_code: bankCode,
      from,
      to,
      kpi_version: "kpi-mock-0.1",
    },
    rows: [{ kpi: "evo_pct", value: evoPct, unit: "ratio" }],
  });
  return true;
}

// -------------------------
// router table (order matters)
// -------------------------
const routes = [
  routeRoot,
  routeHealth,

  // L2 minimal (tomorrow scope)
  routeApiV1Health,
  routeProfileLifeLiquidityStub,

  // existing routes
  routeDbPing,
  routeTxns,
  routeMissingMonths,
  routeKpi,
];

// -------------------------
// server
// -------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader("Connection", "close");

  try {
    if (setCors(req, res)) return;
    if (shouldRejectWhenShuttingDown(res)) return;

    const url = safeUrl(req);

    for (const r of routes) {
      // eslint-disable-next-line no-await-in-loop
      const handled = await r(req, res, url);
      if (handled) return;
    }

    sendJSON(res, 404, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "not_found",
      error: "not_found",
      method: req.method,
      path: url.pathname,
    });
  } catch (e) {
    sendJSON(res, 500, {
      ok: false,
      success: false,
      ...makeBasePayload(),
      error_code: "server_error",
      error: "server_error",
      message: String(e && (e.message || e)),
    });
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} in use. Set TEL_API_PORT to another value, or set TEL_API_PORT=0 for auto port.`
    );
    process.exit(1);
    return;
  }
  console.error("Server error:", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const realPort = addr && typeof addr === "object" ? addr.port : PORT;
  listenInfo = { host: HOST, port: realPort };
  console.log(`API listening on http://${HOST}:${realPort}`);
});

// -------------------------
// shutdown and crash hygiene
// -------------------------
async function shutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    console.log(`Shutting down (${signalName})...`);
  } catch (e) {}

  server.close(async () => {
    try {
      if (pool && pool.end) await pool.end();
    } catch (e) {}
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdown("uncaughtException");
});


