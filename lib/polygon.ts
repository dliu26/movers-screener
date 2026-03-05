// lib/polygon.ts
// Polygon.io fetch wrapper with retry/backoff and typed response interfaces.

const BASE_URL = "https://api.polygon.io";

// Retry on these HTTP status codes
const RETRYABLE_STATUSES = new Set([429, 503, 504]);

// Retry delays in ms: first retry after 300ms, second after 900ms
const RETRY_DELAYS_MS = [300, 900];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core fetch wrapper with retry/backoff.
 * Returns { data, retriedDueToRateLimit }.
 */
async function polygonFetch<T>(
  path: string,
  params: Record<string, string>
): Promise<{ data: T; retriedDueToRateLimit: boolean }> {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    throw new Error("POLYGON_API_KEY environment variable is not set");
  }

  const url = new URL(path, BASE_URL);
  url.searchParams.set("apiKey", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let retriedDueToRateLimit = false;
  let lastError: Error = new Error("Unknown fetch error");

  // Attempt 0 + 2 retries = 3 total attempts
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }

    try {
      const response = await fetch(url.toString(), { cache: "no-store" });

      if (RETRYABLE_STATUSES.has(response.status)) {
        retriedDueToRateLimit = true;
        lastError = new Error(`HTTP ${response.status}`);
        continue; // retry
      }

      if (!response.ok) {
        throw new Error(`Polygon API error: HTTP ${response.status}`);
      }

      const data: T = await response.json();
      return { data, retriedDueToRateLimit };
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
}

// ─── Polygon API Types ────────────────────────────────────────────────────────

export interface PolygonDayBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
}

export interface PolygonPrevDayBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
}

export interface PolygonLastTrade {
  p: number;   // price
  s: number;   // size
  t: number;   // timestamp (ns)
  x: number;   // exchange id
  c?: number[];
  i?: string;
}

export interface PolygonMinBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
  av: number;
  n: number;
  t: number;
}

export interface PolygonTickerSnapshot {
  ticker: string;
  todaysChange: number;
  todaysChangePerc: number;
  updated: number;
  day: PolygonDayBar;
  prevDay: PolygonPrevDayBar;
  lastTrade?: PolygonLastTrade;
  min?: PolygonMinBar;
}

export interface PolygonSnapshotAllResponse {
  status: string;
  count: number;
  tickers: PolygonTickerSnapshot[];
}

export interface PolygonAggBar {
  t: number;   // timestamp (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
  n: number;
}

export interface PolygonAggResponse {
  ticker: string;
  status: string;
  resultsCount: number;
  results?: PolygonAggBar[];
}

export interface PolygonTickerDetailResult {
  ticker: string;
  name: string;
  market_cap?: number | null;
  description?: string;
}

export interface PolygonTickerDetailResponse {
  status: string;
  results: PolygonTickerDetailResult;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all US stock snapshots.
 * GET /v2/snapshot/locale/us/markets/stocks/tickers
 *
 * NOTE: snapshot-all-tickers may omit very illiquid tickers that haven't
 * traded recently (so nanos/micros might be missing from results).
 */
export async function fetchSnapshotAllTickers(): Promise<{
  data: PolygonSnapshotAllResponse;
  retriedDueToRateLimit: boolean;
}> {
  return polygonFetch<PolygonSnapshotAllResponse>(
    "/v2/snapshot/locale/us/markets/stocks/tickers",
    {}
  );
}

/**
 * Fetch daily aggregate bars for a ticker over a date range.
 * GET /v2/aggs/ticker/{ticker}/range/1/day/{startDate}/{endDate}
 * Returns up to 500 bars sorted ascending; caller takes first + last for start/end close.
 */
export async function fetchTickerAggRange(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<{ data: PolygonAggResponse; retriedDueToRateLimit: boolean }> {
  return polygonFetch<PolygonAggResponse>(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${startDate}/${endDate}`,
    { adjusted: "true", sort: "asc", limit: "500" }
  );
}

/**
 * Fetch detail for a single ticker.
 * GET /v3/reference/tickers/{ticker}
 * This endpoint returns market_cap on all Polygon tiers.
 */
export async function fetchTickerDetail(ticker: string): Promise<{
  data: PolygonTickerDetailResponse;
  retriedDueToRateLimit: boolean;
}> {
  return polygonFetch<PolygonTickerDetailResponse>(
    `/v3/reference/tickers/${encodeURIComponent(ticker)}`,
    {}
  );
}
