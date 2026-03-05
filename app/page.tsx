"use client";

import { useState, useCallback, useEffect } from "react";

// ─── Types (mirror API response shape) ───────────────────────────────────────

interface MoverCard {
  ticker: string;
  name: string | null;
  price: number;
  changePct: number;
  changeAbs: number;
  marketCap: number | null;
  marketCapFormatted: string;
}

interface MoversResponse {
  asOf: string;
  bucket: string;
  limit: number;
  timeframe: string;
  gainers: MoverCard[];
  losers: MoverCard[];
  warnings: string[];
}

type Timeframe = "1D" | "1W" | "1M" | "6M" | "1Y";
type MarketCapBucket = "all" | "nano" | "micro" | "small" | "mid" | "large" | "mega";

const TIMEFRAME_OPTIONS: Timeframe[] = ["1D", "1W", "1M", "6M", "1Y"];

const BUCKET_LABELS: Record<MarketCapBucket, string> = {
  all:   "All Caps",
  nano:  "Nano (< $50M)",
  micro: "Micro ($50M – $300M)",
  small: "Small ($300M – $2B)",
  mid:   "Mid ($2B – $10B)",
  large: "Large ($10B – $200B)",
  mega:  "Mega (> $200B)",
};

const LIMIT_OPTIONS = [50, 100, 200] as const;

const MIN_CAP_OPTIONS: { label: string; value: number }[] = [
  { label: "None",  value: 0 },
  { label: "100M",  value: 100_000_000 },
  { label: "500M",  value: 500_000_000 },
  { label: "1B",    value: 1_000_000_000 },
  { label: "5B",    value: 5_000_000_000 },
  { label: "10B",   value: 10_000_000_000 },
];

// ─── MoverCardItem ────────────────────────────────────────────────────────────

function MoverCardItem({ card, isGainer }: { card: MoverCard; isGainer: boolean }) {
  const sign = card.changePct >= 0 ? "+" : "";
  const absSign = card.changeAbs >= 0 ? "+" : "-";
  const changeColor = isGainer ? "text-green-400" : "text-red-400";
  const bgAccent = isGainer ? "hover:border-green-800" : "hover:border-red-800";

  return (
    <div
      className={`flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 transition-colors ${bgAccent}`}
    >
      {/* Left: Ticker + Name */}
      <div className="min-w-0 flex-1 pr-3">
        <p className="font-mono text-sm font-bold text-white">{card.ticker}</p>
        <p className="truncate text-xs text-gray-400" title={card.name ?? undefined}>
          {card.name ?? "—"}
        </p>
      </div>

      {/* Right: Price + Change + Market Cap */}
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <p className="font-mono text-sm font-semibold text-white">
          ${card.price.toFixed(2)}
        </p>
        <p className={`font-mono text-xs font-medium ${changeColor}`}>
          {sign}{card.changePct.toFixed(2)}%&nbsp;
          ({absSign}${Math.abs(card.changeAbs).toFixed(2)})
        </p>
        <p className="text-xs text-gray-500">{card.marketCapFormatted}</p>
      </div>
    </div>
  );
}

// ─── MoverColumn ──────────────────────────────────────────────────────────────

function MoverColumn({
  title,
  cards,
  isGainer,
  loading,
}: {
  title: string;
  cards: MoverCard[];
  isGainer: boolean;
  loading: boolean;
}) {
  const headerColor = isGainer ? "text-green-400" : "text-red-400";

  return (
    <div className="flex w-full flex-col md:min-h-0 md:flex-1">
      <h2 className={`mb-3 text-base font-bold tracking-tight ${headerColor}`}>
        {title}
        {!loading && cards.length > 0 && (
          <span className="ml-2 text-xs font-normal text-gray-500">
            ({cards.length})
          </span>
        )}
      </h2>

      <div className="overflow-y-auto space-y-2 pr-1 md:h-[calc(100vh-200px)]">
        {loading ? (
          Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-800" />
          ))
        ) : cards.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-600">
            No results for this filter.
          </p>
        ) : (
          cards.map((card) => (
            <MoverCardItem key={card.ticker} card={card} isGainer={isGainer} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MoversScreenerPage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [bucket, setBucket] = useState<MarketCapBucket>("all");
  const [limit, setLimit] = useState<number>(50);
  const [minCap, setMinCap] = useState<number>(0);
  const [data, setData] = useState<MoversResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const fetchMovers = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ timeframe, bucket, limit: String(limit) });
      if (minCap > 0) params.set("minCap", String(minCap));
      const response = await fetch(`/api/movers?${params.toString()}`);
      const json = await response.json();

      if (!response.ok) {
        setError(json.error ?? `Server error (HTTP ${response.status})`);
        setData(null);
      } else {
        setData(json as MoversResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [timeframe, bucket, limit, minCap]);

  // Fetch on mount and whenever controls change
  useEffect(() => {
    fetchMovers();
  }, [fetchMovers]);

  const asOfLabel = data?.asOf
    ? timeframe === "1D"
      ? `As of: ${new Date(data.asOf).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}`
      : `${timeframe} return as of ${new Date(data.asOf).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`
    : null;

  return (
    <div className="flex flex-col p-4 md:h-screen md:overflow-hidden">
      {/* ── Header ── */}
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="mr-2 text-xl font-bold tracking-tight text-white">
          Movers Screener
        </h1>

        {/* Timeframe */}
        <label className="flex items-center gap-1.5 text-sm text-gray-400">
          <span>Timeframe:</span>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as Timeframe)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {TIMEFRAME_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        {/* Market Cap Bucket */}
        <label className="flex items-center gap-1.5 text-sm text-gray-400">
          <span>Cap:</span>
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value as MarketCapBucket)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {(Object.keys(BUCKET_LABELS) as MarketCapBucket[]).map((b) => (
              <option key={b} value={b}>
                {BUCKET_LABELS[b]}
              </option>
            ))}
          </select>
        </label>

        {/* Limit */}
        <label className="flex items-center gap-1.5 text-sm text-gray-400">
          <span>Limit:</span>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {LIMIT_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>

        {/* Min Cap */}
        <label className="flex items-center gap-1.5 text-sm text-gray-400">
          <span>Min Cap:</span>
          <select
            value={minCap}
            onChange={(e) => setMinCap(Number(e.target.value))}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {MIN_CAP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {/* Refresh */}
        <button
          onClick={fetchMovers}
          disabled={loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>

        {/* As of / timeframe label */}
        {asOfLabel && (
          <span className="ml-auto text-xs text-gray-500">
            {asOfLabel}
          </span>
        )}
      </header>

      {/* ── Warnings ── */}
      {data?.warnings && data.warnings.length > 0 && (
        <div className="mb-3 space-y-0.5 rounded border border-yellow-700/60 bg-yellow-950/50 px-3 py-2">
          {data.warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-300">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="mb-3 rounded border border-red-700/60 bg-red-950/50 px-3 py-2">
          <p className="text-sm text-red-300">Error: {error}</p>
        </div>
      )}

      {/* ── Two-Column Layout ── */}
      <div className="flex flex-col gap-4 md:flex-row md:min-h-0 md:flex-1 md:overflow-hidden">
        <MoverColumn
          title="Top Gainers"
          cards={data?.gainers ?? []}
          isGainer={true}
          loading={loading}
        />
        <MoverColumn
          title="Top Losers"
          cards={data?.losers ?? []}
          isGainer={false}
          loading={loading}
        />
      </div>
    </div>
  );
}
