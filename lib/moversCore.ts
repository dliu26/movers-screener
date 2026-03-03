// lib/moversCore.ts
// Shared types, constants, and helpers used by both the API route and cron job.

import type { PolygonTickerSnapshot } from "@/lib/polygon";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MoverCard {
  ticker: string;
  name: string | null;
  price: number;
  changePct: number;
  changeAbs: number;
  marketCap: number | null;
  marketCapFormatted: string;
}

// Internal type for a scored snapshot row before cache join
export interface ScoredTicker {
  ticker: string;
  price: number;
  changePct: number;
  changeAbs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// How many candidates to pre-fetch market cap data for per side
export const CANDIDATE_COUNT = 200;

// /^[A-Z]{1,5}$/ accepts only plain uppercase-letter tickers, which
// filters out warrants (W suffix), rights (R suffix), units (dot),
// and preferred shares (letter/digit suffixes) in one pass.
export const COMMON_STOCK_RE = /^[A-Z]{1,5}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive price using the fallback chain:
 * day.c → lastTrade.p → min.c → prevDay.c
 */
export function derivePrice(snap: PolygonTickerSnapshot): number | null {
  if (snap.day?.c != null)       return snap.day.c;
  if (snap.lastTrade?.p != null) return snap.lastTrade.p;
  if (snap.min?.c != null)       return snap.min.c;
  if (snap.prevDay?.c != null)   return snap.prevDay.c;
  return null;
}

/**
 * Format market cap to human-readable string.
 * e.g. 2_100_000_000 → "$2.10B"
 */
export function formatMarketCap(marketCap: number | null): string {
  if (marketCap === null) return "N/A";
  if (marketCap >= 1_000_000_000_000) return `$${(marketCap / 1_000_000_000_000).toFixed(2)}T`;
  if (marketCap >= 1_000_000_000)     return `$${(marketCap / 1_000_000_000).toFixed(2)}B`;
  if (marketCap >= 1_000_000)         return `$${(marketCap / 1_000_000).toFixed(2)}M`;
  return `$${marketCap.toLocaleString()}`;
}
