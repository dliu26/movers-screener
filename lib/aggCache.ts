// lib/aggCache.ts
//
// In-memory cache for historical aggregate (startClose, endClose) data.
// Keyed by "TICKER:TIMEFRAME". TTL: 1 hour. No disk persistence.

import { fetchTickerAggRange } from "@/lib/polygon";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AggCacheEntry {
  startClose: number;
  endClose: number;
  fetchedAt: number; // Unix ms
}

// ─── Config ──────────────────────────────────────────────────────────────────

const AGG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 10;

// ─── Store ───────────────────────────────────────────────────────────────────

const aggCache = new Map<string, AggCacheEntry>();

function aggKey(ticker: string, timeframe: string): string {
  return `${ticker.toUpperCase()}:${timeframe}`;
}

function isExpired(entry: AggCacheEntry): boolean {
  return Date.now() - entry.fetchedAt > AGG_CACHE_TTL_MS;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns cached (startClose, endClose) for a ticker+timeframe, or null if
 * missing or expired.
 */
export function getAggCacheEntry(
  ticker: string,
  timeframe: string,
): AggCacheEntry | null {
  const entry = aggCache.get(aggKey(ticker, timeframe));
  if (!entry || isExpired(entry)) return null;
  return entry;
}

/**
 * Fetch aggregate data for any tickers not already cached (or expired).
 * Fires up to BATCH_SIZE concurrent requests per batch.
 *
 * Tickers with < 2 bars in the range are skipped (can't compute change).
 */
export async function enrichAggTickers(
  tickers: string[],
  timeframe: string,
  startDate: string,
  endDate: string,
): Promise<{ retriedDueToRateLimit: boolean }> {
  const needsFetch = tickers
    .map((t) => t.toUpperCase())
    .filter((t) => {
      const entry = aggCache.get(aggKey(t, timeframe));
      return !entry || isExpired(entry);
    });

  if (needsFetch.length === 0) return { retriedDueToRateLimit: false };

  let anyRateLimit = false;

  for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
    const batch = needsFetch.slice(i, i + BATCH_SIZE);
    const now = Date.now();

    const results = await Promise.allSettled(
      batch.map((ticker) => fetchTickerAggRange(ticker, startDate, endDate))
    );

    for (let j = 0; j < batch.length; j++) {
      const ticker = batch[j];
      const result = results[j];

      if (result.status === "fulfilled") {
        if (result.value.retriedDueToRateLimit) anyRateLimit = true;
        const bars = result.value.data.results;
        if (bars && bars.length >= 2) {
          aggCache.set(aggKey(ticker, timeframe), {
            startClose: bars[0].c,
            endClose: bars[bars.length - 1].c,
            fetchedAt: now,
          });
        }
        // < 2 bars: not cached — ticker excluded from scoring
      } else {
        console.error(`[aggCache] Failed to fetch agg for ${ticker}:`, result.reason);
      }
    }
  }

  return { retriedDueToRateLimit: anyRateLimit };
}
