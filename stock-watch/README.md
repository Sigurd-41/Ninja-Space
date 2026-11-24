# Stock Watch

A personal watchlist and charting app that runs on your own computer: up to 50 symbols, live-refreshing prices, candlestick charts with volume, VWAP, RSI, EMAs, SMAs and Bollinger Bands.

## Start it

You need Python 3.9 or newer. Macs usually have it; on Windows, install it from python.org and tick **"Add python.exe to PATH"**. Nothing else needs to be installed.

- **Mac:** double-click `Start Stock Watch (Mac).command`. The first time, macOS may block it: right-click it, choose **Open**, then **Open** again.
- **Windows:** double-click `Start Stock Watch (Windows).bat`.
- **Or in a terminal:** `python3 server.py`

Your browser opens to http://localhost:8765. Keep the small terminal window open while you use the app; close it to stop.

To try the app without internet, run `python3 server.py --demo`. It fills in made-up prices.

## What you get

**Watchlist (left)**
| Column | Meaning |
|---|---|
| Last / Chg % | Latest price and change from the previous close |
| Volume | Today's total consolidated volume (all exchanges). Hover to see the 30-day average daily volume. |
| RVol | Relative volume: today's volume so far vs. the average of the last 20 sessions **at the same time of day**. 2× or more is highlighted. |
| vs VWAP | How far the price is above or below today's VWAP |
| RSI 5m / RSI D | RSI(14) on 5-minute and daily bars. 70+ shows red, 30 or below shows green. |
| Today | Sparkline of today's session; the dashed line is the previous close |

Click a column header to sort. Click a row (or use ↑/↓) to chart it. Add several symbols at once, e.g. `AAPL, MSFT, NVDA`. Remove one with ×. The list is saved in `watchlist.json`.

**Chart (right)**: timeframes 1m, 5m, 15m, 30m, 1h, 1D and 1W, with candles, volume bars with a 20-bar average, and an RSI(14) panel. Optional overlays: VWAP (resets each session; intraday only), EMA 9/21, SMA 50/200 and Bollinger Bands (20, 2). Scroll to zoom and drag to pan.

**Refresh**: choose 1, 5, 10 or 15 minutes in the top bar (default 5), or click **Refresh now**. The chart refreshes too.

## About the data

Prices come from Yahoo Finance's public chart data, the same feed behind finance.yahoo.com. It's free and needs no account, and the volume is consolidated across all exchanges. However:

- It is **unofficial**. Yahoo doesn't offer it as a supported API, so it's meant for personal use and could change or break without notice. If that happens, the data source is isolated in `server.py` (`Yahoo.chart`), so it can be swapped for a paid provider such as Polygon/Massive, Tiingo or Alpaca SIP.
- US stock quotes are generally real-time or close to it during market hours. Compare a few prices with your broker when you first use it.
- The last 5-minute bar is still forming, so its volume grows until the bar closes.
- 50 symbols refreshed every 5 minutes is about 600 requests an hour, which is light. The server caches results, so reloading the page doesn't send extra requests.

Weekends and market holidays: the app shows the last session's data. The "market open/closed" badge uses regular US hours (9:30–16:00 ET) and doesn't know about holidays.

## Files

- `server.py`: small local web server and data fetcher (Python standard library only)
- `static/`: the app page (`index.html`, `app.js`, `styles.css`)
- `static/vendor/`: TradingView Lightweight Charts™ v4.2.3 (Apache 2.0, see `LICENSE` there)

Not investment advice.
