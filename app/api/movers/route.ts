// app/api/movers/route.ts
// TODO: if deploying publicly, consider adding auth/rate limiting to /api/movers

import { NextRequest, NextResponse } from "next/server";
import { fetchSnapshotAllTickers } from "@/lib/polygon";
import { enrichTickers, getCacheEntryOrEmpty, getTopTickersByMarketCap } from "@/lib/marketCapCache";
import { enrichAggTickers, getAggCacheEntry } from "@/lib/aggCache";
import {
  MoverCard,
  ScoredTicker,
  CANDIDATE_COUNT,
  COMMON_STOCK_RE,
  Timeframe,
  VALID_TIMEFRAMES,
  getStartDate,
  derivePrice,
  formatMarketCap,
} from "@/lib/moversCore";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MoversResponse {
  asOf: string;
  bucket: string;
  limit: number;
  timeframe: string;
  gainers: MoverCard[];
  losers: MoverCard[];
  warnings: string[];
}

export interface MoversErrorResponse {
  error: string;
  asOf: string;
  warnings: string[];
}

type MarketCapBucket = "all" | "nano" | "micro" | "small" | "mid" | "large" | "mega";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_LIMITS = [50, 100, 200] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const VALID_BUCKETS = new Set<string>([
  "all", "nano", "micro", "small", "mid", "large", "mega",
]);

// Market cap bucket boundaries in dollars (inclusive min, exclusive max)
const BUCKET_RANGES: Record<Exclude<MarketCapBucket, "all">, [number, number]> = {
  nano:  [0,                50_000_000],
  micro: [50_000_000,       300_000_000],
  small: [300_000_000,      2_000_000_000],
  mid:   [2_000_000_000,    10_000_000_000],
  large: [10_000_000_000,   200_000_000_000],
  mega:  [200_000_000_000,  Infinity],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) return DEFAULT_LIMIT;
  if (parsed > MAX_LIMIT) return MAX_LIMIT;
  // Clamp to nearest allowed value
  return ALLOWED_LIMITS.reduce((prev, curr) =>
    Math.abs(curr - parsed) < Math.abs(prev - parsed) ? curr : prev
  );
}

function validateBucket(raw: string | null): MarketCapBucket {
  if (raw && VALID_BUCKETS.has(raw)) return raw as MarketCapBucket;
  return "all";
}

function validateMinCap(raw: string | null): number {
  if (!raw) return 0;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) return 0;
  return Math.max(0, parsed);
}

function validateTimeframe(raw: string | null): Timeframe {
  if (raw && VALID_TIMEFRAMES.has(raw)) return raw as Timeframe;
  return "1D";
}

/**
 * Returns true if a ticker should be included given the market cap bucket.
 * "all" includes tickers with unknown (null) market cap.
 * Specific buckets exclude tickers with null market cap.
 */
function matchesBucket(marketCap: number | null, bucket: MarketCapBucket): boolean {
  if (bucket === "all") return true;
  if (marketCap === null) return false;
  const [min, max] = BUCKET_RANGES[bucket];
  return marketCap >= min && marketCap < max;
}

function buildMoverCard(scored: ScoredTicker): MoverCard {
  const { marketCap, name } = getCacheEntryOrEmpty(scored.ticker);
  return {
    ticker: scored.ticker,
    name,
    price: scored.price,
    changePct: scored.changePct,
    changeAbs: scored.changeAbs,
    marketCap,
    marketCapFormatted: formatMarketCap(marketCap),
  };
}

/** Shared bucket + minCap filter used by both pipelines. */
function passesFilters(ticker: string, bucket: MarketCapBucket, minCap: number): boolean {
  const { marketCap } = getCacheEntryOrEmpty(ticker);
  if (!matchesBucket(marketCap, bucket)) return false;
  if (minCap > 0 && (marketCap === null || marketCap < minCap)) return false;
  return true;
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const asOf = new Date().toISOString();
  const warnings: string[] = [];

  try {
    const { searchParams } = request.nextUrl;
    const bucket = validateBucket(searchParams.get("bucket"));
    const limit = validateLimit(searchParams.get("limit"));
    const minCap = validateMinCap(searchParams.get("minCap"));
    const timeframe = validateTimeframe(searchParams.get("timeframe"));

    // ── Historical pipeline (1W / 1M / 6M / 1Y) ──────────────────────────────
    if (timeframe !== "1D") {
      const universe = getTopTickersByMarketCap(500);

      if (universe.length < 50) {
        warnings.push(
          "Market cap cache is empty or too sparse for historical view. " +
          "Load the 1D view first to warm the cache, then retry."
        );
      }

      const startDate = getStartDate(timeframe);
      const endDate = new Date().toISOString().slice(0, 10);

      const { retriedDueToRateLimit: aggRetried } = await enrichAggTickers(
        universe, timeframe, startDate, endDate
      );
      if (aggRetried) {
        warnings.push(
          "Rate limit hit while fetching historical data; some tickers may be missing."
        );
      }

      // Score: use agg-derived prices
      const scored: ScoredTicker[] = [];
      for (const ticker of universe) {
        const entry = getAggCacheEntry(ticker, timeframe);
        if (!entry) continue;

        const { startClose, endClose } = entry;
        if (endClose < 0.10) continue;

        const changeAbs = endClose - startClose;
        const changePct = (changeAbs / startClose) * 100;
        if (changePct <= -99) continue;

        scored.push({ ticker, price: endClose, changePct, changeAbs });
      }

      const candidateGainers = [...scored].sort((a, b) => b.changePct - a.changePct);
      const candidateLosers  = [...scored].sort((a, b) => a.changePct - b.changePct);

      const gainers = candidateGainers
        .filter((c) => passesFilters(c.ticker, bucket, minCap))
        .slice(0, limit)
        .map(buildMoverCard);

      const losers = candidateLosers
        .filter((c) => passesFilters(c.ticker, bucket, minCap))
        .slice(0, limit)
        .map(buildMoverCard);

      const body: MoversResponse = { asOf, bucket, limit, timeframe, gainers, losers, warnings };
      return NextResponse.json(body, { status: 200 });
    }

    // ── 1D pipeline (snapshot) ────────────────────────────────────────────────

    // 1. Fetch snapshot data
    const { data: snapshotData, retriedDueToRateLimit: snapshotRetried } =
      await fetchSnapshotAllTickers();

    if (snapshotRetried) {
      warnings.push(
        "Rate limit hit while fetching snapshot data; results may reflect slightly delayed data."
      );
    }

    const tickers = snapshotData.tickers ?? [];

    // 2. Warn if snapshot universe is suspiciously small
    if (tickers.length < 2000) {
      warnings.push(
        `Snapshot returned only ${tickers.length} tickers (expected ≥2000); ` +
        `market may be closed or data may be incomplete.`
      );
    }

    // 3. Score every ticker: compute price + changePct, discard junk rows.
    // NOTE: snapshot-all-tickers may omit very illiquid tickers that haven't
    // traded recently (so nanos/micros might be missing from results).
    const scored: ScoredTicker[] = [];

    for (const snap of tickers) {
      // (a) Skip non-common-stock instrument classes
      if (!COMMON_STOCK_RE.test(snap.ticker)) continue;

      const price = derivePrice(snap);
      if (price === null) continue;

      const prevClose = snap.prevDay?.c;
      if (prevClose == null || prevClose === 0) continue;

      // (b) Skip sub-penny / dead securities
      if (price < 0.10) continue;

      const changeAbs = price - prevClose;
      const changePct = (changeAbs / prevClose) * 100;

      // (c) Skip effectively-zeroed tickers (data artefacts near -100%)
      if (changePct <= -99) continue;

      scored.push({ ticker: snap.ticker, price, changePct, changeAbs });
    }

    // 4. Select candidate sets: top CANDIDATE_COUNT gainers + top CANDIDATE_COUNT losers
    const candidateGainers = [...scored]
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, CANDIDATE_COUNT);

    const candidateLosers = [...scored]
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, CANDIDATE_COUNT);

    // Union of both sets (already sorted; dedup by ticker)
    const candidateSet = new Set<string>([
      ...candidateGainers.map((c) => c.ticker),
      ...candidateLosers.map((c) => c.ticker),
    ]);

    // 5. Enrich cache for candidates (fetches missing/expired per-ticker detail)
    const { retriedDueToRateLimit: enrichRetried } = await enrichTickers(
      Array.from(candidateSet)
    );
    if (enrichRetried) {
      warnings.push(
        "Rate limit hit while fetching ticker reference data; some market-cap values may be missing."
      );
    }

    // 6. Warn if market cap coverage among candidates is low
    let knownCount = 0;
    for (const ticker of Array.from(candidateSet)) {
      if (getCacheEntryOrEmpty(ticker).marketCap !== null) knownCount++;
    }
    if (candidateSet.size > 0 && knownCount / candidateSet.size < 0.7) {
      const coveragePct = ((knownCount / candidateSet.size) * 100).toFixed(1);
      warnings.push(
        `Market cap coverage is low among top movers: ${knownCount}/${candidateSet.size} ` +
        `(${coveragePct}%). Bucket filtering may be unreliable.`
      );
    }

    // 7. Apply bucket + minCap filters and slice to limit
    const gainers = candidateGainers
      .filter((c) => passesFilters(c.ticker, bucket, minCap))
      .slice(0, limit)
      .map(buildMoverCard);

    const losers = candidateLosers
      .filter((c) => passesFilters(c.ticker, bucket, minCap))
      .slice(0, limit)
      .map(buildMoverCard);

    const body: MoversResponse = { asOf, bucket, limit, timeframe, gainers, losers, warnings };
    return NextResponse.json(body, { status: 200 });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown server error";
    console.error("[/api/movers] Error:", errorMessage);

    const isUpstream =
      errorMessage.includes("HTTP 502") ||
      errorMessage.includes("HTTP 503") ||
      errorMessage.includes("HTTP 504") ||
      errorMessage.includes("Polygon API error");

    const body: MoversErrorResponse = { error: errorMessage, asOf, warnings };
    return NextResponse.json(body, { status: isUpstream ? 502 : 500 });
  }
}
