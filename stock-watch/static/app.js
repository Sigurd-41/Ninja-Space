/* Stock Watch front end. Talks to server.py at /api/*. */
(() => {
  "use strict";
  const LWC = window.LightweightCharts;
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const store = {
    get(k, d) { try { const v = localStorage.getItem("sw." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("sw." + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const state = {
    symbols: [],
    quotes: new Map(),
    sel: store.get("sel", null),
    tf: store.get("tf", "5m"),
    inds: store.get("inds", { vwap: true, volma: true }),
    sortKey: store.get("sortKey", null),
    sortDir: store.get("sortDir", -1),
    refreshMin: store.get("refreshMin", 5),
    nextAt: 0,
    loading: false,
  };

  // ---------------------------------------------------------------- formatting
  const fmtPrice = (x) => x == null ? "—" : x.toLocaleString(undefined, { minimumFractionDigits: x < 1 ? 4 : 2, maximumFractionDigits: x < 1 ? 4 : 2 });
  const fmtPct = (x) => x == null ? "—" : (x > 0 ? "+" : "") + x.toFixed(2) + "%";
  const fmtVol = (x) => {
    if (x == null) return "—";
    const a = Math.abs(x);
    if (a >= 1e9) return (x / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (x / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (x / 1e3).toFixed(1) + "K";
    return String(Math.round(x));
  };
  const cls = (x) => x == null ? "" : x > 0 ? "up" : x < 0 ? "down" : "";
  const rsiCls = (x) => x == null ? "" : x >= 70 ? "ob" : x <= 30 ? "os" : "";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  // ---------------------------------------------------------------- market status (US regular hours, ignores holidays)
  function marketOpen() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    const mins = (+p.hour % 24) * 60 + +p.minute;
    return !["Sat", "Sun"].includes(p.weekday) && mins >= 570 && mins < 960;
  }
  function paintStatus() {
    const open = marketOpen();
    const el = $("#marketStatus");
    el.textContent = open ? "US market open" : "US market closed";
    el.className = "pill " + (open ? "open" : "closed");
  }

  // ---------------------------------------------------------------- watchlist
  function sortedSymbols() {
    const syms = state.symbols.slice();
    const k = state.sortKey;
    if (!k) return syms;
    return syms.sort((a, b) => {
      const qa = state.quotes.get(a) || {}, qb = state.quotes.get(b) || {};
      const va = k === "symbol" ? a : qa[k], vb = k === "symbol" ? b : qb[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * state.sortDir;
      return (va - vb) * state.sortDir;
    });
  }

  function spark(q) {
    const pts = q.spark || [];
    if (pts.length < 2) return "";
    const w = 70, h = 22;
    const ref = q.prevClose ?? pts[0];
    const lo = Math.min(...pts, ref), hi = Math.max(...pts, ref);
    const span = hi - lo || 1;
    const x = (i) => (i / (pts.length - 1)) * w;
    const y = (v) => h - 1 - ((v - lo) / span) * (h - 2);
    const d = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const col = pts[pts.length - 1] >= ref ? css("--up") : css("--down");
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" x2="${w}" y1="${y(ref).toFixed(1)}" y2="${y(ref).toFixed(1)}" stroke="${css("--line")}" stroke-dasharray="2 2"/><polyline fill="none" stroke="${col}" stroke-width="1.2" points="${d}"/></svg>`;
  }

  function renderTable(prev) {
    const tb = $("#watchTable tbody");
    const rows = sortedSymbols().map((s) => {
      const q = state.quotes.get(s);
      const sel = s === state.sel ? " sel" : "";
      if (!q) return `<tr data-s="${esc(s)}" class="${sel}"><td class="sym">${esc(s)}</td><td colspan="8" class="muted l">loading…</td><td><button class="del" data-del="${esc(s)}" title="Remove">×</button></td></tr>`;
      if (q.error) return `<tr data-s="${esc(s)}" class="${sel}"><td class="sym">${esc(s)}</td><td colspan="8" class="err">${esc(q.error).slice(0, 90)}</td><td><button class="del" data-del="${esc(s)}" title="Remove">×</button></td></tr>`;
      const p = prev && prev.get(s);
      const flash = p && p.last != null && q.last != null && p.last !== q.last ? (q.last > p.last ? " flash-up" : " flash-down") : "";
      const rv = q.rvol == null ? "—" : q.rvol.toFixed(2) + "×";
      return `<tr data-s="${esc(s)}" class="${sel}${q.stale ? " stale" : ""}" title="${q.stale ? "Showing the last good data; the latest fetch failed" : ""}">
        <td class="sym">${esc(s)}<small>${esc(q.name || "")}</small></td>
        <td class="${flash.trim()}">${fmtPrice(q.last)}</td>
        <td class="${cls(q.chgPct)}">${fmtPct(q.chgPct)}</td>
        <td title="Avg daily (30d): ${fmtVol(q.avgVolume)}">${fmtVol(q.volume)}</td>
        <td class="${q.rvol >= 2 ? "hot" : q.rvol != null && q.rvol < 0.6 ? "muted" : ""}">${rv}</td>
        <td class="${cls(q.vsVwapPct)}" title="VWAP ${fmtPrice(q.vwap)}">${fmtPct(q.vsVwapPct)}</td>
        <td class="${rsiCls(q.rsi5m)}">${q.rsi5m == null ? "—" : q.rsi5m.toFixed(0)}</td>
        <td class="${rsiCls(q.rsiD)}">${q.rsiD == null ? "—" : q.rsiD.toFixed(0)}</td>
        <td>${spark(q)}</td>
        <td><button class="del" data-del="${esc(s)}" title="Remove">×</button></td>
      </tr>`;
    });
    tb.innerHTML = rows.join("") || `<tr><td colspan="10" class="muted l">Your watchlist is empty. Add a symbol above.</td></tr>`;
    document.querySelectorAll("#watchTable th[data-k]").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.k === state.sortKey);
      th.classList.toggle("asc", th.dataset.k === state.sortKey && state.sortDir === 1);
    });
    $("#symCount").textContent = `${state.symbols.length}/50`;
  }

  async function loadQuotes() {
    if (state.loading) return;
    state.loading = true;
    $("#refreshNow").disabled = true;
    try {
      const { quotes } = await api("/api/quotes");
      const prev = state.quotes;
      state.quotes = new Map(quotes.map((q) => [q.symbol, q]));
      renderTable(prev);
      const bad = quotes.filter((q) => q.error).length;
      $("#lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString() + (bad ? ` · ${bad} failed` : "");
    } catch (e) {
      $("#lastUpdated").textContent = "Update failed: " + e.message + " (is server.py running?)";
    } finally {
      state.loading = false;
      $("#refreshNow").disabled = false;
      schedule();
    }
  }

  async function saveSymbols(list) {
    const { symbols } = await api("/api/symbols", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: list }) });
    state.symbols = symbols;
    renderTable();
  }

  // ---------------------------------------------------------------- refresh timer
  function schedule() { state.nextAt = Date.now() + state.refreshMin * 60000; }
  function tick() {
    paintStatus();
    const left = Math.max(0, state.nextAt - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $("#countdown").textContent = state.nextAt ? `next in ${m}:${String(s).padStart(2, "0")}` : "";
    if (state.nextAt && left === 0 && !state.loading) {
      loadQuotes();
      loadChart(false);
    }
  }

  // ---------------------------------------------------------------- indicators
  function sma(vals, n) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function ema(vals, n) {
    const out = new Array(vals.length).fill(null);
    const k = 2 / (n + 1);
    let e = null;
    for (let i = 0; i < vals.length; i++) {
      if (i === n - 1) e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
      else if (i >= n) e = vals[i] * k + e * (1 - k);
      if (e != null) out[i] = e;
    }
    return out;
  }
  function rsi(vals, n = 14) {
    const out = new Array(vals.length).fill(null);
    if (vals.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = vals[i] - vals[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  function stdev(vals, n, means) {
    return vals.map((_, i) => {
      if (means[i] == null) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (vals[j] - means[i]) ** 2;
      return Math.sqrt(s / n);
    });
  }
  // VWAP that resets at the start of each trading day. `day` gives a session key per bar.
  function vwap(bars, day) {
    const out = [];
    let pv = 0, vv = 0, cur = null;
    bars.forEach((b, i) => {
      const d = day(b);
      const newSession = d !== cur;
      if (newSession) { pv = 0; vv = 0; cur = d; }
      pv += ((b.h + b.l + b.c) / 3) * b.v;
      vv += b.v;
      out.push({ v: vv > 0 ? pv / vv : null, gap: newSession && i > 0 });
    });
    return out;
  }

  // ---------------------------------------------------------------- charts
  const chartOpts = (showTime) => ({
    autoSize: true,
    layout: { background: { type: "solid", color: css("--bg") }, textColor: css("--muted"), fontSize: 11 },
    grid: { vertLines: { color: "rgba(42,49,59,.5)" }, horzLines: { color: "rgba(42,49,59,.5)" } },
    rightPriceScale: { borderColor: css("--line"), minimumWidth: 72 },
    timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false, visible: showTime, rightOffset: 4 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
  });
  const main = LWC.createChart($("#mainChart"), chartOpts(false));
  const rsiC = LWC.createChart($("#rsiChart"), { ...chartOpts(true), layout: { ...chartOpts(true).layout, attributionLogo: false } });
  main.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.26 } });

  const candles = main.addCandlestickSeries({
    upColor: css("--up"), downColor: css("--down"), borderVisible: false,
    wickUpColor: css("--up"), wickDownColor: css("--down"),
  });
  const volume = main.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
  const line = (color, extra = {}) => main.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
  const overlays = {
    vwap: line(css("--vwap"), { lineWidth: 2 }),
    ema9: line(css("--ema9")),
    ema21: line(css("--ema21")),
    sma50: line(css("--sma50")),
    sma200: line(css("--sma200")),
    bbU: line(css("--bb"), { lineStyle: 2, lineWidth: 1 }),
    bbM: line(css("--bb"), { lineWidth: 1 }),
    bbL: line(css("--bb"), { lineStyle: 2, lineWidth: 1 }),
    volma: line(css("--volma"), { priceScaleId: "vol", lineWidth: 1 }),
  };
  const rsiLine = rsiC.addLineSeries({ color: css("--rsi"), lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false });
  rsiLine.createPriceLine({ price: 70, color: css("--down"), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "" });
  rsiLine.createPriceLine({ price: 30, color: css("--up"), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "" });
  rsiLine.createPriceLine({ price: 50, color: css("--line"), lineStyle: 3, lineWidth: 1, axisLabelVisible: false, title: "" });
  rsiC.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
  rsiLine.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });

  // keep the two charts scrolled/zoomed together
  let syncing = false;
  const sync = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (syncing || !r) return;
    syncing = true; to.timeScale().setVisibleLogicalRange(r); syncing = false;
  });
  sync(main, rsiC); sync(rsiC, main);

  let chartData = { bars: [], rsi: [], times: [] };
  function legend(i) {
    const b = chartData.bars[i];
    if (!b) { $("#legend").innerHTML = ""; return; }
    const c = b.c >= b.o ? "up" : "down";
    const r = chartData.rsi[i];
    const vw = chartData.vwap && chartData.vwap[i] && chartData.vwap[i].v;
    $("#legend").innerHTML = `<span>O <b class="${c}">${fmtPrice(b.o)}</b></span><span>H <b class="${c}">${fmtPrice(b.h)}</b></span><span>L <b class="${c}">${fmtPrice(b.l)}</b></span><span>C <b class="${c}">${fmtPrice(b.c)}</b></span><span>Vol <b>${fmtVol(b.v)}</b></span>` +
      (state.inds.vwap && vw && isIntraday() ? `<span style="color:var(--vwap)">VWAP ${fmtPrice(vw)}</span>` : "") +
      (r != null ? `<span style="color:var(--rsi)">RSI ${r.toFixed(1)}</span>` : "");
  }
  const idxOf = (time) => chartData.index.get(time);
  main.subscribeCrosshairMove((p) => {
    if (!p.time) { legend(chartData.bars.length - 1); rsiC.clearCrosshairPosition(); return; }
    const i = idxOf(p.time);
    legend(i);
    if (chartData.rsi[i] != null) rsiC.setCrosshairPosition(chartData.rsi[i], p.time, rsiLine); else rsiC.clearCrosshairPosition();
  });
  rsiC.subscribeCrosshairMove((p) => {
    if (!p.time) { main.clearCrosshairPosition(); return; }
    const i = idxOf(p.time);
    legend(i);
    if (chartData.bars[i]) main.setCrosshairPosition(chartData.bars[i].c, p.time, candles);
  });

  const isIntraday = () => !["1D", "1W"].includes(state.tf);
  let chartReq = 0;

  async function loadChart(resetView) {
    const sym = state.sel;
    if (!sym) return;
    const my = ++chartReq;
    $("#chSym").textContent = sym;
    const msg = $("#chartMsg");
    if (resetView) { msg.hidden = false; msg.textContent = "Loading…"; }
    let data;
    try {
      data = await api(`/api/chart?symbol=${encodeURIComponent(sym)}&tf=${state.tf}`);
    } catch (e) {
      if (my !== chartReq) return;
      msg.hidden = false; msg.textContent = `Could not load ${sym}: ${e.message}`;
      return;
    }
    if (my !== chartReq) return; // a newer request superseded this one
    msg.hidden = true;
    const off = data.meta.gmtoffset || 0;
    $("#chName").textContent = (data.meta.longName || data.meta.shortName || "") + (data.stale ? " · showing last good data" : "");
    // Dedupe/sort by time (Yahoo occasionally repeats the live bar)
    const seen = new Map();
    for (const b of data.bars) seen.set(b.t + off, b);
    const times = [...seen.keys()].sort((a, b) => a - b);
    const bars = times.map((t) => seen.get(t));
    const closes = bars.map((b) => b.c);
    const vols = bars.map((b) => b.v);
    const up = css("--up"), dn = css("--down");

    candles.setData(bars.map((b, i) => ({ time: times[i], open: b.o, high: b.h, low: b.l, close: b.c })));
    volume.setData(bars.map((b, i) => ({ time: times[i], value: b.v, color: (b.c >= b.o ? up : dn) + "88" })));

    const toLine = (arr) => arr.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v }));
    const show = (s, arr, on) => { s.setData(on ? toLine(arr) : []); };
    const vw = vwap(bars, (b) => new Date((b.t + off) * 1000).toISOString().slice(0, 10));
    // A point's colour paints the segment *after* it, so hide the segment that jumps into the next session.
    const vwOn = state.inds.vwap && isIntraday();
    overlays.vwap.setData(!vwOn ? [] : vw.map((x, i) => {
      const p = { time: times[i], value: x.v };
      if (vw[i + 1] && vw[i + 1].gap) p.color = "rgba(0,0,0,0)";
      return p;
    }));
    show(overlays.ema9, ema(closes, 9), state.inds.ema9);
    show(overlays.ema21, ema(closes, 21), state.inds.ema21);
    show(overlays.sma50, sma(closes, 50), state.inds.sma50);
    show(overlays.sma200, sma(closes, 200), state.inds.sma200);
    const mid = sma(closes, 20), sd = stdev(closes, 20, mid);
    show(overlays.bbM, mid, state.inds.bb);
    show(overlays.bbU, mid.map((m, i) => (m == null ? null : m + 2 * sd[i])), state.inds.bb);
    show(overlays.bbL, mid.map((m, i) => (m == null ? null : m - 2 * sd[i])), state.inds.bb);
    show(overlays.volma, sma(vols, 20), state.inds.volma);
    const r = rsi(closes, 14);
    rsiLine.setData(toLine(r));

    chartData = { bars, rsi: r, vwap: vw, times, index: new Map(times.map((t, i) => [t, i])) };
    legend(bars.length - 1);
    $("#rsiLabel").style.top = $("#mainChart").offsetHeight + 4 + "px";
    $("#inds [data-ind=vwap]").closest("label").title = isIntraday() ? "" : "VWAP is shown on intraday timeframes";

    if (resetView && bars.length) {
      const want = isIntraday() ? 160 : 180;
      main.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - want), to: bars.length + 3 });
    }
  }

  // ---------------------------------------------------------------- events
  function select(sym) {
    if (!sym || sym === state.sel) return;
    state.sel = sym;
    store.set("sel", sym);
    document.querySelectorAll("#watchTable tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.s === sym));
    loadChart(true);
  }

  $("#watchTable tbody").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      saveSymbols(state.symbols.filter((s) => s !== del.dataset.del));
      return;
    }
    const tr = e.target.closest("tr[data-s]");
    if (tr) select(tr.dataset.s);
  });

  $("#watchTable thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]");
    if (!th) return;
    const k = th.dataset.k;
    if (state.sortKey !== k) { state.sortKey = k; state.sortDir = k === "symbol" ? 1 : -1; }
    else if (state.sortDir === (k === "symbol" ? 1 : -1)) state.sortDir *= -1;
    else state.sortKey = null;
    store.set("sortKey", state.sortKey); store.set("sortDir", state.sortDir);
    renderTable();
  });

  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = $("#addInput");
    const add = inp.value.toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (!add.length) return;
    const list = state.symbols.concat(add.filter((s) => !state.symbols.includes(s)));
    if (list.length > 50) { alert("The watchlist holds up to 50 symbols."); return; }
    inp.value = "";
    try {
      await saveSymbols(list);
      if (!state.sel) select(add[0]);
      loadQuotes();
    } catch (err) { alert(err.message); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const order = sortedSymbols();
    let i = order.indexOf(state.sel);
    i = e.key === "ArrowDown" ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    select(order[i]);
    const tr = document.querySelector(`#watchTable tr[data-s="${CSS.escape(order[i])}"]`);
    if (tr) tr.scrollIntoView({ block: "nearest" });
  });

  $("#tfs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tf]");
    if (!b) return;
    state.tf = b.dataset.tf;
    store.set("tf", state.tf);
    document.querySelectorAll("#tfs button").forEach((x) => x.classList.toggle("on", x === b));
    loadChart(true);
  });

  document.querySelectorAll("#inds input").forEach((cb) => {
    cb.checked = !!state.inds[cb.dataset.ind];
    cb.addEventListener("change", () => {
      state.inds[cb.dataset.ind] = cb.checked;
      store.set("inds", state.inds);
      loadChart(false);
    });
  });

  const rs = $("#refreshSel");
  rs.value = String(state.refreshMin);
  rs.addEventListener("change", () => { state.refreshMin = +rs.value; store.set("refreshMin", state.refreshMin); schedule(); });
  $("#refreshNow").addEventListener("click", () => { loadQuotes(); loadChart(false); });
  window.addEventListener("resize", () => { $("#rsiLabel").style.top = $("#mainChart").offsetHeight + 4 + "px"; });

  // ---------------------------------------------------------------- start
  (async function init() {
    document.querySelectorAll("#tfs button").forEach((x) => x.classList.toggle("on", x.dataset.tf === state.tf));
    try {
      const j = await api("/api/symbols");
      state.symbols = j.symbols;
      $("#demoBadge").hidden = !j.demo;
    } catch (e) {
      $("#lastUpdated").textContent = "Cannot reach server.py — start it and reload this page.";
      return;
    }
    if (!state.symbols.includes(state.sel)) state.sel = state.symbols[0] || null;
    renderTable();
    paintStatus();
    const s = state.sel; state.sel = null; select(s);
    loadQuotes();
    setInterval(tick, 1000);
  })();
})();
