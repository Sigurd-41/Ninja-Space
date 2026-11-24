#!/usr/bin/env python3
"""Stock Watch - a small personal watchlist + charting app.

Run:   python3 server.py            (live data from Yahoo Finance)
       python3 server.py --demo     (made-up data, works offline)
Then open http://localhost:8765 in your browser.

Only the Python standard library is used, so there is nothing to install.
"""

import argparse
import datetime as dt
import hashlib
import http.cookiejar
import json
import math
import os
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
WATCHLIST_FILE = os.path.join(HERE, "watchlist.json")
DEFAULT_SYMBOLS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD"]
MAX_SYMBOLS = 50
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-^=]{1,15}$")

# Chart timeframes: our name -> (Yahoo interval, Yahoo range)
TIMEFRAMES = {
    "1m": ("1m", "5d"),
    "5m": ("5m", "1mo"),
    "15m": ("15m", "1mo"),
    "30m": ("30m", "2mo"),
    "1h": ("60m", "6mo"),
    "1D": ("1d", "2y"),
    "1W": ("1wk", "10y"),
}
# How long a fetched result is reused before asking Yahoo again (seconds).
CACHE_TTL = {"1m": 30, "5m": 60, "15m": 60, "30m": 120, "60m": 120, "1d": 600, "1wk": 3600}

DEMO = False
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")


# --------------------------------------------------------------------------
# Yahoo Finance fetching (with a cookie/crumb fallback if Yahoo demands one)
# --------------------------------------------------------------------------

class Yahoo:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.crumb = None
        self.lock = threading.Lock()

    def _get(self, url, timeout=15):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        with self.opener.open(req, timeout=timeout) as r:
            return r.read()

    def _refresh_crumb(self):
        with self.lock:
            try:
                self._get("https://fc.yahoo.com")
            except Exception:
                pass  # this URL 404s but still sets the cookie we need
            try:
                self.crumb = self._get("https://query1.finance.yahoo.com/v1/test/getcrumb").decode().strip()
            except Exception:
                self.crumb = None

    def chart(self, symbol, interval, rng):
        params = {"interval": interval, "range": rng, "includePrePost": "false", "events": "div,splits"}
        last_err = None
        for attempt in range(3):
            if self.crumb:
                params["crumb"] = self.crumb
            host = "query1" if attempt % 2 == 0 else "query2"
            url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?" + urllib.parse.urlencode(params)
            try:
                return json.loads(self._get(url))
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code in (401, 403):
                    self._refresh_crumb()
                elif e.code == 404:
                    break
                elif e.code == 429:
                    time.sleep(1.5 * (attempt + 1))
            except Exception as e:
                last_err = e
                time.sleep(0.5)
        raise RuntimeError(f"{symbol}: {last_err}")


YAHOO = Yahoo()


def _seed(*parts):
    return int.from_bytes(hashlib.sha256(repr(parts).encode()).digest()[:8], "big")


DEMO_OFF = -18000  # US Eastern (standard time)


def _sessions(n):
    d = dt.datetime.fromtimestamp(time.time() + DEMO_OFF, dt.timezone.utc).date()
    out = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= dt.timedelta(days=1)
    return out[::-1]


def _open_utc(sd):
    return int(dt.datetime(sd.year, sd.month, sd.day, 9, 30, tzinfo=dt.timezone.utc).timestamp()) - DEMO_OFF


def _demo_day(symbol, sd, open_px, step):
    """Intraday bars for one session as a random walk; partial for today."""
    now = time.time()
    is_today = _open_utc(sd) + 390 * 60 > now and _open_utc(sd) <= now
    # Today's path changes each minute so refreshes visibly move
    r = random.Random(_seed(symbol, sd.isoformat(), int(now // 60) if is_today else 0))
    base_vol = 3_000_000 + _seed(symbol) % 40_000_000
    day_vol_mult = 0.6 + r.random() * 0.9
    out, px = [], open_px
    for i in range(390 * 60 // step):
        t = _open_utc(sd) + i * step
        if t > now:
            break
        k = step / 60
        o = px
        c = max(0.5, px * (1 + r.gauss(0.00002 * k, 0.0011 * math.sqrt(k))))
        h = max(o, c) * (1 + abs(r.gauss(0, 0.0006 * math.sqrt(k))))
        lo = min(o, c) * (1 - abs(r.gauss(0, 0.0006 * math.sqrt(k))))
        minute = i * step // 60
        shape = 2.2 if minute < 30 else 1.6 if minute > 360 else 0.8
        v = int(base_vol / 390 * k * shape * day_vol_mult * abs(r.gauss(1, 0.35))) + 100
        out.append((t, o, h, lo, c, v))
        px = c
    return out


def _demo_daily(symbol, n):
    r = random.Random(_seed(symbol, "daily"))
    px = 20 + r.random() * 400
    rows = []
    sessions = _sessions(n)
    for sd in sessions[:-1]:
        o = px
        c = max(0.5, px * (1 + r.gauss(0.0004, 0.018)))
        h = max(o, c) * (1 + abs(r.gauss(0, 0.007)))
        lo = min(o, c) * (1 - abs(r.gauss(0, 0.007)))
        v = int((3_000_000 + _seed(symbol) % 40_000_000) * (0.6 + r.random() * 0.9))
        rows.append((_open_utc(sd), o, h, lo, c, v))
        px = c
    return rows, sessions, px


def demo_chart(symbol, interval, rng):
    """Synthetic Yahoo-shaped response so the app runs without internet."""
    step = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86400, "1wk": 604800}[interval]
    days = {"5d": 5, "1mo": 22, "2mo": 44, "6mo": 126, "1y": 252, "2y": 504, "10y": 2520}[rng]
    daily, sessions, last_close = _demo_daily(symbol, 2600)
    # today's session (may be empty before the open)
    today_sd = sessions[-1]
    today = _demo_day(symbol, today_sd, last_close, 60)
    if today:
        daily.append((today[0][0], today[0][1], max(b[2] for b in today), min(b[3] for b in today), today[-1][4], sum(b[5] for b in today)))
    rows = []
    if step == 86400:
        rows = daily[-days:]
    elif step == 604800:
        week = None
        for b in daily[-days:]:
            wk = local_date(b[0], DEMO_OFF).isocalendar()[:2]
            if week and week[0] == wk:
                w = week[1]
                week[1] = (w[0], w[1], max(w[2], b[2]), min(w[3], b[3]), b[4], w[5] + b[5])
            else:
                if week:
                    rows.append(week[1])
                week = [wk, b]
        if week:
            rows.append(week[1])
    else:
        for b in daily[-days:]:
            sd = local_date(b[0], DEMO_OFF)
            mins = _demo_day(symbol, sd, b[1], 60) if sd != today_sd else today
            if sd != today_sd and mins:  # rescale so the path ends at the daily close
                f = b[4] / mins[-1][4]
                mins = [(t, o if i == 0 else o * f ** (i / len(mins)), h * f ** (i / len(mins)), lo * f ** (i / len(mins)), c * f ** ((i + 1) / len(mins)), v) for i, (t, o, h, lo, c, v) in enumerate(mins)]
            agg = step // 60
            for j in range(0, len(mins), agg):
                g = mins[j:j + agg]
                rows.append((g[0][0], g[0][1], max(x[2] for x in g), min(x[3] for x in g), g[-1][4], sum(x[5] for x in g)))
    ts = [b[0] for b in rows]
    o, h, l, c, v = ([round(b[i], 2) if i < 5 else b[i] for b in rows] for i in range(1, 6))
    tb = today or [daily[-1]]
    return {"chart": {"result": [{
        "meta": {
            "symbol": symbol, "currency": "USD", "exchangeName": "DEMO", "longName": f"{symbol} (demo data)",
            "regularMarketPrice": round(tb[-1][4], 2), "chartPreviousClose": round(last_close, 2), "previousClose": round(last_close, 2),
            "regularMarketVolume": sum(b[5] for b in today) if today else 0,
            "regularMarketDayHigh": round(max(b[2] for b in tb), 2), "regularMarketDayLow": round(min(b[3] for b in tb), 2),
            "regularMarketTime": tb[-1][0], "gmtoffset": DEMO_OFF, "exchangeTimezoneName": "America/New_York",
        },
        "timestamp": ts,
        "indicators": {"quote": [{"open": o, "high": h, "low": l, "close": c, "volume": v}]},
    }], "error": None}}


# --------------------------------------------------------------------------
# Cache + normalisation
# --------------------------------------------------------------------------

_cache = {}
_cache_lock = threading.Lock()


def get_chart(symbol, interval, rng):
    """Returns {'meta': {...}, 'bars': [{t,o,h,l,c,v}], 'stale': bool}."""
    key = (symbol, interval, rng)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL.get(interval, 60):
        return hit[1]
    try:
        raw = demo_chart(symbol, interval, rng) if DEMO else YAHOO.chart(symbol, interval, rng)
        data = normalise(raw)
    except Exception as e:
        if hit:  # serve the last good copy rather than nothing
            return dict(hit[1], stale=True, error=str(e))
        raise
    with _cache_lock:
        _cache[key] = (now, data)
    return data


def normalise(raw):
    chart = raw.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(chart["error"].get("description") or str(chart["error"]))
    res = (chart.get("result") or [None])[0]
    if not res:
        raise RuntimeError("no data")
    meta = res.get("meta", {})
    ts = res.get("timestamp") or []
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    bars = []
    for i, t in enumerate(ts):
        try:
            o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
            v = q["volume"][i] or 0
        except (KeyError, IndexError, TypeError):
            continue
        if None in (o, h, l, c):
            continue
        bars.append({"t": t, "o": o, "h": h, "l": l, "c": c, "v": v})
    return {"meta": meta, "bars": bars, "stale": False}


# --------------------------------------------------------------------------
# Indicators for the watchlist table
# --------------------------------------------------------------------------

def rsi(closes, period=14):
    if len(closes) <= period:
        return None
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0); losses += max(-d, 0)
    ag, al = gains / period, losses / period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (period - 1) + max(d, 0)) / period
        al = (al * (period - 1) + max(-d, 0)) / period
    if al == 0:
        return 100.0
    return 100 - 100 / (1 + ag / al)


def local_date(t, off):
    return dt.datetime.fromtimestamp(t + off, dt.timezone.utc).date()


def local_minute(t, off):
    x = dt.datetime.fromtimestamp(t + off, dt.timezone.utc)
    return x.hour * 60 + x.minute


def quote_row(symbol):
    intraday = get_chart(symbol, "5m", "1mo")
    try:
        daily = get_chart(symbol, "1d", "1y")
    except Exception:
        daily = {"meta": {}, "bars": []}
    m = intraday["meta"]
    off = m.get("gmtoffset", 0) or 0
    bars = intraday["bars"]
    last = m.get("regularMarketPrice") or (bars[-1]["c"] if bars else None)
    mtime = m.get("regularMarketTime") or (bars[-1]["t"] if bars else time.time())
    session = local_date(mtime, off)

    # Previous close = last daily close before the current session
    prev = None
    for b in reversed(daily["bars"]):
        if local_date(b["t"], off) < session:
            prev = b["c"]; break
    if prev is None:
        prev = m.get("previousClose") or m.get("chartPreviousClose")

    # Group 5m bars by session day
    by_day = {}
    for b in bars:
        by_day.setdefault(local_date(b["t"], off), []).append(b)
    today = by_day.get(session, [])

    vwap = None
    pv = sum((b["h"] + b["l"] + b["c"]) / 3 * b["v"] for b in today)
    vv = sum(b["v"] for b in today)
    if vv > 0:
        vwap = pv / vv

    # Relative volume at this time of day vs. the prior 20 sessions
    rvol = None
    if today:
        cutoff = local_minute(today[-1]["t"], off)
        prior_days = sorted(d for d in by_day if d < session)[-20:]
        cums = [sum(b["v"] for b in by_day[d] if local_minute(b["t"], off) <= cutoff) for d in prior_days]
        cums = [x for x in cums if x > 0]
        if cums and vv > 0:
            rvol = vv / (sum(cums) / len(cums))

    dbars = [b for b in daily["bars"] if local_date(b["t"], off) < session][-30:]
    avg_vol = sum(b["v"] for b in dbars) / len(dbars) if dbars else None

    dcloses = [b["c"] for b in daily["bars"] if local_date(b["t"], off) < session]
    if last is not None:
        dcloses.append(last)
    chg = (last - prev) if (last is not None and prev) else None

    return {
        "symbol": symbol,
        "name": m.get("longName") or m.get("shortName") or "",
        "last": last,
        "prevClose": prev,
        "chg": chg,
        "chgPct": (chg / prev * 100) if chg is not None else None,
        "volume": m.get("regularMarketVolume") or vv,
        "avgVolume": avg_vol,
        "rvol": rvol,
        "vwap": vwap,
        "vsVwapPct": ((last - vwap) / vwap * 100) if (vwap and last) else None,
        "rsi5m": rsi([b["c"] for b in bars][-200:]),
        "rsiD": rsi(dcloses[-250:]),
        "dayHigh": m.get("regularMarketDayHigh"),
        "dayLow": m.get("regularMarketDayLow"),
        "time": mtime,
        "spark": [b["c"] for b in today],
        "stale": intraday.get("stale", False),
    }


POOL = ThreadPoolExecutor(max_workers=6)


def watchlist_quotes(symbols):
    def one(s):
        try:
            return quote_row(s)
        except Exception as e:
            return {"symbol": s, "error": str(e)}
    return list(POOL.map(one, symbols))


# --------------------------------------------------------------------------
# Watchlist storage
# --------------------------------------------------------------------------

def load_symbols():
    try:
        with open(WATCHLIST_FILE) as f:
            syms = json.load(f).get("symbols", [])
            return [s for s in syms if SYMBOL_RE.match(s)][:MAX_SYMBOLS]
    except (OSError, ValueError):
        return list(DEFAULT_SYMBOLS)


def save_symbols(syms):
    clean = []
    for s in syms:
        s = str(s).strip().upper()
        if SYMBOL_RE.match(s) and s not in clean:
            clean.append(s)
    clean = clean[:MAX_SYMBOLS]
    tmp = WATCHLIST_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"symbols": clean}, f, indent=2)
    os.replace(tmp, WATCHLIST_FILE)
    return clean


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            return  # keep the console quiet
        super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, allow_nan=False, default=lambda x: None).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/symbols":
                return self.send_json({"symbols": load_symbols(), "demo": DEMO, "max": MAX_SYMBOLS})
            if u.path == "/api/quotes":
                syms = load_symbols()
                return self.send_json({"quotes": clean_nan(watchlist_quotes(syms)), "serverTime": time.time()})
            if u.path == "/api/chart":
                sym = q.get("symbol", [""])[0].upper()
                tf = q.get("tf", ["5m"])[0]
                if not SYMBOL_RE.match(sym) or tf not in TIMEFRAMES:
                    return self.send_json({"error": "bad symbol or timeframe"}, 400)
                data = get_chart(sym, *TIMEFRAMES[tf])
                return self.send_json(clean_nan(data))
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api/symbols":
            return self.send_json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            return self.send_json({"symbols": save_symbols(body.get("symbols", []))})
        except Exception as e:
            return self.send_json({"error": str(e)}, 400)


def clean_nan(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    if isinstance(x, dict):
        return {k: clean_nan(v) for k, v in x.items()}
    if isinstance(x, list):
        return [clean_nan(v) for v in x]
    return x


def main():
    global DEMO
    ap = argparse.ArgumentParser(description="Stock Watch")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--demo", action="store_true", help="use made-up data (no internet needed)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    DEMO = args.demo
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"Stock Watch running at {url}  ({'DEMO data' if DEMO else 'live Yahoo Finance data'})")
    print("Leave this window open. Press Ctrl+C to stop.")
    if not args.no_browser:
        import webbrowser
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
