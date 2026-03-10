/* eslint-env node */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const http = require("http");
const { openConnection } = require("./db");

const SERVICE = "tel-api";
const VERSION = "tel-api-profile-0.6.2";

const HOST = process.env.TEL_API_HOST || process.env.HOST || "127.0.0.1";
const PORT_RAW = process.env.TEL_API_PORT || process.env.PORT || "3001";
const PORT = Number.isFinite(Number(PORT_RAW)) ? Number(PORT_RAW) : 3001;

const CORS_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "600",
};

function sendJson(res, status, obj) {
  res.writeHead(status, CORS_HEADERS);
  res.end(JSON.stringify(obj));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  return {
    pathname: url.pathname,
    q: Object.fromEntries(url.searchParams.entries()),
  };
}

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isYm(s) {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}

function clampInt(x, def, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function quoteId(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

function normBook(s) {
  return String(s ?? "").trim().toUpperCase();
}

function normBankCode(s) {
  return String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "");
}

function pickColumn(cols, candidates) {
  const lower = new Map(cols.map((c) => [String(c).toLowerCase(), c]));
  for (const cand of candidates) {
    const hit = lower.get(String(cand).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function monthKeyList(from, to) {
  const out = [];
  const [fromY, fromM] = String(from).slice(0, 7).split("-").map(Number);
  const [toY, toM] = String(to).slice(0, 7).split("-").map(Number);

  let y = fromY;
  let m = fromM;

  while (y < toY || (y === toY && m <= toM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return out;
}

function toJsonDateOrNull(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toYm(v) {
  if (v == null) return null;
  return String(v).slice(0, 7);
}

function badRequestRangeBody(message, raw, normalized) {
  return {
    error: "bad_request",
    message,
    version: VERSION,
    query_raw: raw,
    query: normalized,
  };
}

function normalizeRangeQuery(rawQ) {
  const bookRaw = rawQ.book;
  const bankRaw = rawQ.bank_code;
  const from = rawQ.from;
  const to = rawQ.to;

  const book = normBook(bookRaw);
  const bank_code = normBankCode(bankRaw);
  const normalized = { book, bank_code, from, to };

  if (!book || !bank_code || !isYmd(from) || !isYmd(to)) {
    return {
      ok: false,
      status: 400,
      body: badRequestRangeBody(
        "required: book, bank_code, from(YYYY-MM-DD), to(YYYY-MM-DD)",
        { book: bookRaw, bank_code: bankRaw, from, to },
        normalized
      ),
    };
  }

  if (from > to) {
    return {
      ok: false,
      status: 400,
      body: badRequestRangeBody(
        "require: from <= to",
        { book: bookRaw, bank_code: bankRaw, from, to },
        normalized
      ),
    };
  }

  return { ok: true, query: normalized };
}

function normalizeMonthRangeQuery(rawQ) {
  const bookRaw = rawQ.book;
  const bankRaw = rawQ.bank_code;
  const from = rawQ.from;
  const to = rawQ.to;

  const book = normBook(bookRaw);
  const bank_code = normBankCode(bankRaw);
  const normalized = { book, bank_code, from, to };

  if (!book || !bank_code || !isYm(from) || !isYm(to)) {
    return {
      ok: false,
      status: 400,
      body: badRequestRangeBody(
        "required: book, bank_code, from(YYYY-MM), to(YYYY-MM)",
        { book: bookRaw, bank_code: bankRaw, from, to },
        normalized
      ),
    };
  }

  if (from > to) {
    return {
      ok: false,
      status: 400,
      body: badRequestRangeBody(
        "require: from <= to",
        { book: bookRaw, bank_code: bankRaw, from, to },
        normalized
      ),
    };
  }

  return { ok: true, query: normalized };
}

function sqlNormTextExpr(expr) {
  return `REPLACE(REPLACE(UPPER(TRIM(${expr})), ' ', ''), '-', '')`;
}

function sqlNormBookExpr(expr) {
  return `UPPER(TRIM(${expr}))`;
}

async function objectExists(conn, objName) {
  const [rows] = await conn.execute(
    `SELECT 1 AS ok
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?
     LIMIT 1`,
    [objName]
  );
  return rows.length > 0;
}

async function getColumns(conn, tableName) {
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME AS col
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
     ORDER BY ordinal_position`,
    [tableName]
  );
  return rows.map((r) => r.col).filter((x) => x != null && x !== "");
}

async function resolveTxnSource(conn) {
  if (await objectExists(conn, "v_fact_txn_pretty")) return "v_fact_txn_pretty";
  if (await objectExists(conn, "fact_txn")) return "fact_txn";
  return null;
}

async function resolveTxnContext(conn) {
  const table = await resolveTxnSource(conn);

  if (!table) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "no_source_table",
        message: "expected v_fact_txn_pretty or fact_txn",
        version: VERSION,
      },
    };
  }

  const cols = await getColumns(conn, table);

  const ctx = {
    table,
    columns: cols,
    dateCol: pickColumn(cols, ["txn_date", "日期", "date"]),
    bookCol: pickColumn(cols, ["account_book", "book", "帳簿"]),
    bankCol: pickColumn(cols, ["bank_code", "bankcode", "銀行代碼", "銀行"]),
    balanceCol: pickColumn(cols, ["balance", "running_balance", "餘額"]),
    idCol: pickColumn(cols, ["txn_id", "id"]),
  };

  if (!ctx.dateCol || !ctx.bookCol || !ctx.bankCol) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "missing_required_column",
        message: "need recognized columns for date/book/bank_code",
        version: VERSION,
        source: {
          table: ctx.table,
          date_col: ctx.dateCol,
          book_col: ctx.bookCol,
          bank_col: ctx.bankCol,
          balance_col: ctx.balanceCol,
          id_col: ctx.idCol,
        },
        columns: cols,
      },
    };
  }

  return { ok: true, ctx };
}

async function resolveMonthlySummaryContext(conn) {
  const table = "v_monthly_summary";

  if (!(await objectExists(conn, table))) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "no_source_table",
        message: "expected v_monthly_summary",
        version: VERSION,
      },
    };
  }

  const cols = await getColumns(conn, table);

  const ctx = {
    table,
    columns: cols,
    bookCol: pickColumn(cols, ["book"]),
    bankCol: pickColumn(cols, ["bank_code", "bankcode"]),
    monthCol: pickColumn(cols, ["month"]),
    inflowCol: pickColumn(cols, ["inflow"]),
    outflowCol: pickColumn(cols, ["outflow"]),
    netCol: pickColumn(cols, ["net"]),
    txnCountCol: pickColumn(cols, ["txn_count"]),
    missingAmountTxnCountCol: pickColumn(cols, ["missing_amount_txn_count"]),
  };

  if (
    !ctx.bookCol ||
    !ctx.bankCol ||
    !ctx.monthCol ||
    !ctx.inflowCol ||
    !ctx.outflowCol ||
    !ctx.netCol ||
    !ctx.txnCountCol ||
    !ctx.missingAmountTxnCountCol
  ) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "missing_required_column",
        message: "need recognized columns for v_monthly_summary",
        version: VERSION,
        source: {
          table: ctx.table,
          book_col: ctx.bookCol,
          bank_col: ctx.bankCol,
          month_col: ctx.monthCol,
          inflow_col: ctx.inflowCol,
          outflow_col: ctx.outflowCol,
          net_col: ctx.netCol,
          txn_count_col: ctx.txnCountCol,
          missing_amount_txn_count_col: ctx.missingAmountTxnCountCol,
        },
        columns: cols,
      },
    };
  }

  return { ok: true, ctx };
}

function buildTxnWhereSql(ctx) {
  return (
    `${quoteId(ctx.dateCol)} >= ? ` +
    `AND ${quoteId(ctx.dateCol)} < DATE_ADD(?, INTERVAL 1 DAY) ` +
    `AND ${sqlNormBookExpr(quoteId(ctx.bookCol))} = ? ` +
    `AND ${sqlNormTextExpr(quoteId(ctx.bankCol))} = ?`
  );
}

function buildTxnWhereParams(query) {
  return [query.from, query.to, query.book, query.bank_code];
}

function buildMonthlySummaryWhereSql(ctx) {
  return (
    `${quoteId(ctx.monthCol)} IS NOT NULL ` +
    `AND ${quoteId(ctx.monthCol)} >= ? ` +
    `AND ${quoteId(ctx.monthCol)} <= ? ` +
    `AND ${sqlNormBookExpr(quoteId(ctx.bookCol))} = ? ` +
    `AND ${sqlNormTextExpr(quoteId(ctx.bankCol))} = ?`
  );
}

function buildMonthlySummaryWhereParams(query) {
  return [query.from, query.to, query.book, query.bank_code];
}

function isStressMonth(row) {
  const net = toNumberOrNull(row.net) ?? 0;
  const missingAmountTxnCount = toNumberOrNull(row.missing_amount_txn_count) ?? 0;
  return net < 0 || missingAmountTxnCount > 0;
}

function stressReason(row) {
  const reasons = [];
  const net = toNumberOrNull(row.net) ?? 0;
  const missingAmountTxnCount = toNumberOrNull(row.missing_amount_txn_count) ?? 0;

  if (net < 0) reasons.push("NEGATIVE_NET");
  if (missingAmountTxnCount > 0) reasons.push("MISSING_AMOUNT");

  return reasons.join("+");
}

async function dbPing() {
  const conn = await openConnection();
  try {
    const [r1] = await conn.query("SELECT 1 AS ok");
    const [r2] = await conn.query(
      "SELECT VERSION() AS v, CURRENT_USER() AS u, DATABASE() AS db"
    );

    return {
      ok: r1[0].ok,
      v: r2[0].v,
      u: r2[0].u,
      db: r2[0].db,
      service: SERVICE,
      version: VERSION,
    };
  } finally {
    await conn.end();
  }
}

async function profileTxns(rawQ) {
  const parsed = normalizeRangeQuery(rawQ);
  if (!parsed.ok) return { status: parsed.status, body: parsed.body };

  const query = parsed.query;
  const limit = clampInt(rawQ.limit ?? "", 50, 1, 500);

  const conn = await openConnection();
  try {
    const resolved = await resolveTxnContext(conn);
    if (!resolved.ok) return { status: resolved.status, body: resolved.body };

    const { ctx } = resolved;
    const sql =
      `SELECT * ` +
      `FROM ${quoteId(ctx.table)} ` +
      `WHERE ${buildTxnWhereSql(ctx)} ` +
      `ORDER BY ${quoteId(ctx.dateCol)} ASC ` +
      `LIMIT ${limit}`;

    const [rows] = await conn.execute(sql, buildTxnWhereParams(query));

    return {
      status: 200,
      body: {
        ok: 1,
        version: VERSION,
        source: {
          table: ctx.table,
          date_col: ctx.dateCol,
          book_col: ctx.bookCol,
          bank_col: ctx.bankCol,
        },
        query: { ...query, limit },
        rows,
      },
    };
  } finally {
    await conn.end();
  }
}

async function profileMissingMonths(rawQ) {
  const parsed = normalizeRangeQuery(rawQ);
  if (!parsed.ok) return { status: parsed.status, body: parsed.body };

  const query = parsed.query;

  const conn = await openConnection();
  try {
    const resolved = await resolveTxnContext(conn);
    if (!resolved.ok) return { status: resolved.status, body: resolved.body };

    const { ctx } = resolved;
    const sql =
      `SELECT DISTINCT DATE_FORMAT(${quoteId(ctx.dateCol)}, '%Y-%m-01') AS month_key ` +
      `FROM ${quoteId(ctx.table)} ` +
      `WHERE ${buildTxnWhereSql(ctx)} ` +
      `ORDER BY month_key ASC`;

    const [rows] = await conn.execute(sql, buildTxnWhereParams(query));

    const presentMonths = rows
      .map((r) => r.month_key)
      .filter((x) => x != null)
      .map((x) => String(x));

    const expectedMonths = monthKeyList(query.from, query.to);
    const presentSet = new Set(presentMonths);

    const missingMonths = expectedMonths
      .filter((m) => !presentSet.has(m))
      .map((m) => toYm(m));

    return {
      status: 200,
      body: {
        ok: 1,
        version: VERSION,
        route: "/profile/missing-months",
        query,
        count: missingMonths.length,
        months: missingMonths,
        rows: missingMonths.map((month) => ({ month })),
        note: missingMonths.length ? "missing months detected" : "no missing months",
        source: {
          table: ctx.table,
          date_col: ctx.dateCol,
          book_col: ctx.bookCol,
          bank_col: ctx.bankCol,
        },
        meta: {
          expected_cnt: expectedMonths.length,
          present_cnt: presentMonths.length,
          missing_cnt: missingMonths.length,
        },
      },
    };
  } finally {
    await conn.end();
  }
}

async function profileLifeLiquidityKpi(rawQ) {
  const parsed = normalizeRangeQuery(rawQ);
  if (!parsed.ok) return { status: parsed.status, body: parsed.body };

  const query = parsed.query;

  const conn = await openConnection();
  try {
    const resolved = await resolveTxnContext(conn);
    if (!resolved.ok) return { status: resolved.status, body: resolved.body };

    const { ctx } = resolved;

    if (!ctx.balanceCol) {
      return {
        status: 503,
        body: {
          error: "missing_required_column",
          message: "need recognized balance column for kpi",
          version: VERSION,
          source: {
            table: ctx.table,
            date_col: ctx.dateCol,
            book_col: ctx.bookCol,
            bank_col: ctx.bankCol,
            balance_col: ctx.balanceCol,
            id_col: ctx.idCol,
          },
          columns: ctx.columns,
        },
      };
    }

    const whereSql = buildTxnWhereSql(ctx);
    const whereParams = buildTxnWhereParams(query);

    const [summaryRows] = await conn.execute(
      `SELECT
         COUNT(*) AS n_rows,
         MIN(${quoteId(ctx.dateCol)}) AS first_txn_date,
         MAX(${quoteId(ctx.dateCol)}) AS last_txn_date
       FROM ${quoteId(ctx.table)}
       WHERE ${whereSql}`,
      whereParams
    );

    const summary = summaryRows[0];

    if (!summary || Number(summary.n_rows) === 0) {
      return {
        status: 200,
        body: {
          ok: 1,
          version: VERSION,
          q: query,
          rows: [{ kpi: "evo_pct", value: null }],
          meta: {
            n_rows: 0,
            reason: "no_rows_in_range",
            source: {
              table: ctx.table,
              date_col: ctx.dateCol,
              book_col: ctx.bookCol,
              bank_col: ctx.bankCol,
              balance_col: ctx.balanceCol,
              id_col: ctx.idCol,
            },
          },
        },
      };
    }

    const selectId = ctx.idCol ? `${quoteId(ctx.idCol)} AS txn_id, ` : "NULL AS txn_id, ";
    const orderIdAsc = ctx.idCol ? `, ${quoteId(ctx.idCol)} ASC` : "";
    const orderIdDesc = ctx.idCol ? `, ${quoteId(ctx.idCol)} DESC` : "";

    const edgeSql =
      `SELECT edge, txn_id, txn_date, balance
       FROM (
         SELECT
           'start' AS edge,
           ${selectId}
           ${quoteId(ctx.dateCol)} AS txn_date,
           ${quoteId(ctx.balanceCol)} AS balance
         FROM ${quoteId(ctx.table)}
         WHERE ${whereSql}
         ORDER BY ${quoteId(ctx.dateCol)} ASC${orderIdAsc}
         LIMIT 1
       ) s
       UNION ALL
       SELECT edge, txn_id, txn_date, balance
       FROM (
         SELECT
           'end' AS edge,
           ${selectId}
           ${quoteId(ctx.dateCol)} AS txn_date,
           ${quoteId(ctx.balanceCol)} AS balance
         FROM ${quoteId(ctx.table)}
         WHERE ${whereSql}
         ORDER BY ${quoteId(ctx.dateCol)} DESC${orderIdDesc}
         LIMIT 1
       ) e`;

    const [edgeRows] = await conn.execute(edgeSql, [...whereParams, ...whereParams]);

    const startRow = edgeRows.find((r) => r.edge === "start") || null;
    const endRow = edgeRows.find((r) => r.edge === "end") || null;

    const startBalance = startRow?.balance == null ? null : Number(startRow.balance);
    const endBalance = endRow?.balance == null ? null : Number(endRow.balance);

    let evoPct = null;
    let reason = null;

    if (startBalance == null || endBalance == null) {
      reason = "missing_balance";
    } else if (startBalance === 0) {
      reason = "start_balance_zero";
    } else {
      evoPct = Number((((endBalance - startBalance) / startBalance) * 100).toFixed(6));
    }

    return {
      status: 200,
      body: {
        ok: 1,
        version: VERSION,
        q: query,
        rows: [{ kpi: "evo_pct", value: evoPct }],
        meta: {
          n_rows: Number(summary.n_rows),
          first_txn_date: toJsonDateOrNull(summary.first_txn_date),
          last_txn_date: toJsonDateOrNull(summary.last_txn_date),
          start_txn_id: startRow?.txn_id ?? null,
          end_txn_id: endRow?.txn_id ?? null,
          start_txn_date: toJsonDateOrNull(startRow?.txn_date ?? null),
          end_txn_date: toJsonDateOrNull(endRow?.txn_date ?? null),
          start_balance: startBalance,
          end_balance: endBalance,
          reason,
          source: {
            table: ctx.table,
            date_col: ctx.dateCol,
            book_col: ctx.bookCol,
            bank_col: ctx.bankCol,
            balance_col: ctx.balanceCol,
            id_col: ctx.idCol,
          },
        },
      },
    };
  } finally {
    await conn.end();
  }
}

async function fetchMonthlySummaryRows(conn, query) {
  const resolved = await resolveMonthlySummaryContext(conn);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, body: resolved.body };
  }

  const { ctx } = resolved;
  const sql =
    `SELECT
       ${quoteId(ctx.bookCol)} AS book,
       ${quoteId(ctx.bankCol)} AS bank_code,
       ${quoteId(ctx.monthCol)} AS month,
       ${quoteId(ctx.inflowCol)} AS inflow,
       ${quoteId(ctx.outflowCol)} AS outflow,
       ${quoteId(ctx.netCol)} AS net,
       ${quoteId(ctx.txnCountCol)} AS txn_count,
       ${quoteId(ctx.missingAmountTxnCountCol)} AS missing_amount_txn_count
     FROM ${quoteId(ctx.table)}
     WHERE ${buildMonthlySummaryWhereSql(ctx)}
     ORDER BY ${quoteId(ctx.monthCol)} ASC, ${quoteId(ctx.bookCol)} ASC, ${quoteId(ctx.bankCol)} ASC`;

  const [rows] = await conn.execute(sql, buildMonthlySummaryWhereParams(query));
  return { ok: true, ctx, rows };
}

async function profileMonthlySummary(rawQ) {
  const parsed = normalizeMonthRangeQuery(rawQ);
  if (!parsed.ok) return { status: parsed.status, body: parsed.body };

  const query = parsed.query;

  const conn = await openConnection();
  try {
    const fetched = await fetchMonthlySummaryRows(conn, query);
    if (!fetched.ok) return { status: fetched.status, body: fetched.body };

    const { ctx, rows } = fetched;

    return {
      status: 200,
      body: {
        ok: 1,
        version: VERSION,
        route: "/profile/monthly-summary",
        query,
        count: rows.length,
        source: {
          table: ctx.table,
          book_col: ctx.bookCol,
          bank_col: ctx.bankCol,
          month_col: ctx.monthCol,
          inflow_col: ctx.inflowCol,
          outflow_col: ctx.outflowCol,
          net_col: ctx.netCol,
          txn_count_col: ctx.txnCountCol,
          missing_amount_txn_count_col: ctx.missingAmountTxnCountCol,
        },
        rows,
      },
    };
  } finally {
    await conn.end();
  }
}

async function profileStressMonths(rawQ) {
  const parsed = normalizeMonthRangeQuery(rawQ);
  if (!parsed.ok) return { status: parsed.status, body: parsed.body };

  const query = parsed.query;

  const conn = await openConnection();
  try {
    const fetched = await fetchMonthlySummaryRows(conn, query);
    if (!fetched.ok) return { status: fetched.status, body: fetched.body };

    const { ctx } = fetched;

    const stressRows = fetched.rows
      .filter(isStressMonth)
      .map((row) => ({
        month: toYm(row.month),
        inflow: toNumberOrNull(row.inflow),
        outflow: toNumberOrNull(row.outflow),
        net: toNumberOrNull(row.net),
        txn_count: toNumberOrNull(row.txn_count),
        missing_amount_txn_count: toNumberOrNull(row.missing_amount_txn_count),
        stress_reason: stressReason(row),
      }));

    const months = stressRows.map((row) => row.month);

    return {
      status: 200,
      body: {
        ok: 1,
        version: VERSION,
        route: "/profile/stress-months",
        query,
        count: stressRows.length,
        months,
        rows: stressRows,
        note: stressRows.length ? "stress months detected" : "no stress months",
        source: {
          table: ctx.table,
          book_col: ctx.bookCol,
          bank_col: ctx.bankCol,
          month_col: ctx.monthCol,
          inflow_col: ctx.inflowCol,
          outflow_col: ctx.outflowCol,
          net_col: ctx.netCol,
          txn_count_col: ctx.txnCountCol,
          missing_amount_txn_count_col: ctx.missingAmountTxnCountCol,
        },
      },
    };
  } finally {
    await conn.end();
  }
}

async function handleRequest(req) {
  const { pathname, q } = parseUrl(req);

  if (req.method === "OPTIONS") {
    return { status: 200, body: { ok: 1, version: VERSION } };
  }

  if (req.method === "GET" && pathname === "/db/ping") {
    return { status: 200, body: await dbPing() };
  }

  if (req.method === "GET" && pathname === "/profile/txns") {
    return profileTxns(q);
  }

  if (
    req.method === "GET" &&
    (pathname === "/profile/missing-months" ||
      pathname === "/profile/life-liquidity/missing-months")
  ) {
    return profileMissingMonths(q);
  }

  if (req.method === "GET" && pathname === "/profile/life-liquidity/kpi") {
    return profileLifeLiquidityKpi(q);
  }

  if (req.method === "GET" && pathname === "/profile/monthly-summary") {
    return profileMonthlySummary(q);
  }

  if (req.method === "GET" && pathname === "/profile/stress-months") {
    return profileStressMonths(q);
  }

  return {
    status: 404,
    body: {
      error: "not_found",
      version: VERSION,
      path: pathname,
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const out = await handleRequest(req);
    return sendJson(res, out.status, out.body);
  } catch (e) {
    return sendJson(res, 500, {
      error: "server_error",
      message: e && e.message ? e.message : String(e),
      version: VERSION,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${SERVICE} ${VERSION} listening on http://${HOST}:${PORT}`);
});