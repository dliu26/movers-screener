// lib/marketCapCache.ts
//
// Per-ticker in-memory cache backed by a JSON file on disk.
//
// On module load the JSON file is read synchronously and used to pre-populate
// the in-memory Map, so warm data survives server restarts.
//
// IMPORTANT — serverless / Vercel caveat:
//   The JSON file is written to process.cwd() (the project root at dev time).
//   On serverless platforms like Vercel the filesystem is read-only, so the
//   file will not persist across invocations. For production deployments,
//   replace persistCache / loadCacheFromFile with a KV store
//   (e.g. Vercel KV, Upstash Redis).

import fs from "fs";
import path from "path";
import { fetchTickerDetail } from "./polygon";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CacheEntry {
  marketCap: number | null;
  name: string | null;
  fetchedAt: number; // Unix ms — used for per-entry TTL
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const BATCH_SIZE = 10;
const CACHE_FILE_PATH = path.join(process.cwd(), "marketcap-cache.json");

// ─── In-memory store ─────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isEntryExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/** Load cache from disk on module init. Silently ignores missing / invalid file. */
function loadCacheFromFile(): void {
  try {
    const raw = fs.readFileSync(CACHE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [ticker, entry] of Object.entries(parsed)) {
      // Skip stale entries — they will be re-fetched on demand
      if (!isEntryExpired(entry)) {
        cache.set(ticker, entry);
      }
    }
  } catch {
    // File doesn't exist yet or is malformed — start with an empty cache
  }
}

/** Serialize the cache to disk. Errors are logged but never thrown. */
async function persistCache(): Promise<void> {
  try {
    const obj: Record<string, CacheEntry> = {};
    for (const [ticker, entry] of Array.from(cache.entries())) {
      obj[ticker] = entry;
    }
    await fs.promises.writeFile(CACHE_FILE_PATH, JSON.stringify(obj), "utf-8");
  } catch (err) {
    console.error("[marketCapCache] Failed to persist cache to disk:", err);
  }
}

// Run synchronously at module load time
loadCacheFromFile();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a ticker. Returns null if not in cache or if the entry is expired,
 * indicating that the caller should call enrichTickers() first.
 */
export function getCacheEntry(ticker: string): CacheEntry | null {
  const entry = cache.get(ticker.toUpperCase());
  if (!entry || isEntryExpired(entry)) return null;
  return entry;
}

/**
 * Look up a ticker for use in the join step.
 * Always returns a value — uses null fields when no valid cache entry exists.
 */
export function getCacheEntryOrEmpty(ticker: string): { marketCap: number | null; name: string | null } {
  return getCacheEntry(ticker) ?? { marketCap: null, name: null };
}

/**
 * Fetch reference detail for any tickers not already in cache (or expired).
 * Fires up to BATCH_SIZE concurrent requests, persists after each batch.
 *
 * @param tickers List of ticker symbols to ensure are in cache
 * @returns Whether any Polygon rate-limit retries occurred
 */
export async function enrichTickers(
  tickers: string[]
): Promise<{ retriedDueToRateLimit: boolean }> {
  const needsFetch = tickers
    .map((t) => t.toUpperCase())
    .filter((t) => {
      const entry = cache.get(t);
      return !entry || isEntryExpired(entry);
    });

  if (needsFetch.length === 0) return { retriedDueToRateLimit: false };

  let anyRateLimit = false;

  for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
    const batch = needsFetch.slice(i, i + BATCH_SIZE);
    const now = Date.now();

    const results = await Promise.allSettled(
      batch.map((ticker) => fetchTickerDetail(ticker))
    );

    for (let j = 0; j < batch.length; j++) {
      const ticker = batch[j];
      const result = results[j];

      if (result.status === "fulfilled") {
        if (result.value.retriedDueToRateLimit) anyRateLimit = true;
        const detail = result.value.data.results;
        cache.set(ticker, {
          marketCap: detail.market_cap ?? null,
          name: detail.name ?? null,
          fetchedAt: now,
        });
      } else {
        // Store a null entry so we don't hammer the API for bad tickers.
        // It will be re-tried after the TTL expires.
        const reason = result.reason;
        const is404 = reason instanceof Error && reason.message.includes("HTTP 404");
        if (is404) {
          console.log(`[cache] 404 ${ticker} (skipped)`);
        } else {
          console.error(`[marketCapCache] Failed to fetch detail for ${ticker}:`, reason);
        }
        cache.set(ticker, { marketCap: null, name: null, fetchedAt: now });
      }
    }

    await persistCache();
  }

  return { retriedDueToRateLimit: anyRateLimit };
}
