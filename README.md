# movers-screener

Real-time Top Gainers and Top Losers screener for US stocks, built with Next.js 14 (App Router) and Tailwind CSS, powered by [Polygon.io](https://polygon.io).

## Prerequisites

- Node.js >= 18
- A [Polygon.io](https://polygon.io) API key (free tier works; see notes below)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env.local` in the project root:
   ```
   POLYGON_API_KEY=your_polygon_api_key_here
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

4. Build for production:
   ```bash
   npm run build && npm start
   ```

## Usage

- **Cap** dropdown — filter by market cap bucket (All / Nano / Micro / Small / Mid / Large / Mega)
- **Limit** dropdown — show 50, 100, or 200 results per column
- **Refresh** button — manually re-fetch the latest data
- **As of** timestamp — shows when the data was fetched; useful for detecting staleness on weekends/after-hours

## Architecture Notes

### In-memory reference cache

`lib/marketCapCache.ts` uses a Node.js in-process `Map` to cache reference ticker data (company names, market cap) with a 12-hour TTL.

**This cache does not persist across serverless function invocations.** On Vercel and similar platforms, each cold-start worker begins with an empty cache, and multiple workers will not share state.

For production deployments, replace the in-memory cache with a persistent store:
- [Vercel KV](https://vercel.com/docs/storage/vercel-kv) (Redis-compatible)
- [Upstash Redis](https://upstash.com)
- Any Redis instance accessible from your deployment

### Market cap data and bucket filtering

Polygon's `/v3/reference/tickers` list endpoint includes `market_cap` on **Business/Launchpad tier** plans. On the **free tier**, this field is absent, so market cap will be `null` for all tickers.

- **All Caps** bucket always works correctly regardless of tier (includes tickers with unknown market cap)
- **Specific buckets** (Nano, Micro, etc.) require market cap data and will return empty results on the free tier
- A warning is displayed in the UI when market cap coverage falls below 70%

### Snapshot coverage

`/v2/snapshot/locale/us/markets/stocks/tickers` may omit very illiquid tickers that haven't traded recently. Nano/micro-cap stocks are most likely to be missing.

### Rate limiting

The fetch wrapper retries up to twice on HTTP 429/503/504 responses (300ms then 900ms delay). A warning is surfaced in the UI when retries occur.

## File Structure

```
app/
  page.tsx              # "use client" — main screener UI
  layout.tsx            # root layout
  globals.css
  api/movers/
    route.ts            # GET /api/movers?bucket=...&limit=...
lib/
  polygon.ts            # fetch wrapper + retry/backoff + typed interfaces
  marketCapCache.ts     # in-memory TTL cache for ticker name/market cap
```
