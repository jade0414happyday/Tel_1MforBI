const API_BASE_DEFAULT = "http://127.0.0.1:3001";

function buildQs(q = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s)}`);
  }
  return parts.join("&");
}

function pickApiBase({ apiBase, allowFromUrl = true, allowFromStorage = true } = {}) {
  // 優先序：explicit > ?api=... > localStorage > default
  if (apiBase && String(apiBase).trim()) return String(apiBase).trim();

  if (allowFromUrl) {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get("api");
      if (q && q.trim()) return q.trim();
    } catch {}
  }

  if (allowFromStorage) {
    try {
      const s = localStorage.getItem("TEL_API_BASE");
      if (s && s.trim()) return s.trim();
    } catch {}
  }

  return API_BASE_DEFAULT;
}

export function makeApi({
  apiBase,
  timeoutMs = 8000,
  allowFromUrl = true,
  allowFromStorage = true,
} = {}) {
  const base = String(
    pickApiBase({ apiBase, allowFromUrl, allowFromStorage })
  ).replace(/\/+$/, "");

  async function getJson(path, q, { method = "GET" } = {}) {
    const qs = buildQs(q);
    const url = qs ? `${base}${path}?${qs}` : `${base}${path}`;

    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        cache: "no-store",
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });

      const ms = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return { url, data: await res.json(), ms };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      if (e && e.name === "AbortError") throw new Error(`TIMEOUT ${timeoutMs}ms`);
      throw new Error(`${e?.message || e} (${ms}ms)`);
    } finally {
      clearTimeout(timer);
    }
  }

  // 這個 ping 不是必要端點；你後端若沒有 /db/ping 也不會影響其它功能
  async function ping() {
    try {
      return await getJson("/db/ping", {}, { method: "GET" });
    } catch (e) {
      return {
        url: `${base}/db/ping`,
        data: { ok: 0, err: String(e.message || e) },
        ms: 0,
      };
    }
  }

  return {
    base,

    // status probe
    ping,

    // HUD KPI
    lifeLiquidityKpi: (q) => getJson("/profile/life-liquidity/kpi", q),

    // data integrity
    missingMonths: (q) => getJson("/profile/missing-months", q),
    stressMonths: (q) => getJson("/profile/stress-months", q),

    // analytics
    txns: (q) => getJson("/profile/txns", q),
    summary: (q) => getJson("/profile/monthly-summary", q),

    // exposed helper
    _buildQs: buildQs,
  };
}