// app/api/cron/after-hours/route.ts
// Fires at 21:40 UTC (4:40pm ET) on weekdays.
// Reports after-hours movers: lastTrade.p vs day.c, for tickers
// with a trade timestamped after 20:00 UTC (4pm ET).

import { NextRequest, NextResponse } from "next/server";
import { fetchSnapshotAllTickers } from "@/lib/polygon";
import { enrichTickers, getCacheEntryOrEmpty } from "@/lib/marketCapCache";
import {
  MoverCard,
  ScoredTicker,
  CANDIDATE_COUNT,
  COMMON_STOCK_RE,
  formatMarketCap,
} from "@/lib/moversCore";
import { sendViaResend } from "@/lib/email";

const MIN_MARKET_CAP = 500_000_000; // $500M

function buildCard(scored: ScoredTicker): MoverCard {
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── Auth guard ──
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asOf = new Date().toISOString();

  // After-hours start = 20:00 UTC today (4pm EDT / 3pm EST — a safe floor for post-close trades)
  const now = new Date();
  const afterHoursStartMs = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    20, 0, 0,
  );
  const afterHoursStartNs = afterHoursStartMs * 1_000_000; // ms → ns (lastTrade.t is nanoseconds)

  try {
    // 1. Fetch snapshot
    const { data: snapshotData } = await fetchSnapshotAllTickers();
    const tickers = snapshotData.tickers ?? [];

    // 2. Score: only tickers with a post-4pm-ET trade; change vs regular close
    const scored: ScoredTicker[] = [];
    for (const snap of tickers) {
      if (!COMMON_STOCK_RE.test(snap.ticker)) continue;

      // Must have a trade after the after-hours start threshold
      const lastTrade = snap.lastTrade;
      if (!lastTrade || lastTrade.t <= afterHoursStartNs) continue;

      const price = lastTrade.p;
      if (price < 0.10) continue;

      // Reference price is the regular-session close
      const prevClose = snap.day?.c;
      if (prevClose == null || prevClose === 0) continue;

      const changeAbs = price - prevClose;
      const changePct = (changeAbs / prevClose) * 100;
      if (changePct <= -99) continue;

      scored.push({ ticker: snap.ticker, price, changePct, changeAbs });
    }

    // 3. Top candidates per side
    const candidateGainers = [...scored]
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, CANDIDATE_COUNT);

    const candidateLosers = [...scored]
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, CANDIDATE_COUNT);

    // 4. Union for enrichment
    const candidateSet = new Set<string>([
      ...candidateGainers.map((c) => c.ticker),
      ...candidateLosers.map((c) => c.ticker),
    ]);

    // 5. Enrich market cap data
    await enrichTickers(Array.from(candidateSet));

    // 6. Filter: market cap >= $500M, build top-50 lists
    const hasMinCap = (s: ScoredTicker): boolean => {
      const { marketCap } = getCacheEntryOrEmpty(s.ticker);
      return marketCap !== null && marketCap >= MIN_MARKET_CAP;
    };

    const gainers = candidateGainers.filter(hasMinCap).slice(0, 50).map(buildCard);
    const losers  = candidateLosers.filter(hasMinCap).slice(0, 50).map(buildCard);

    // 7. Send email
    const subject = `After-Hours Movers — ${new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
    })}`;
    const result = await sendViaResend(gainers, losers, asOf, subject);

    if (!result.ok) {
      console.error("[cron/after-hours] Resend error:", result.error);
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    console.log(`[cron/after-hours] Email sent — ${gainers.length} gainers, ${losers.length} losers`);
    return NextResponse.json({ ok: true, gainers: gainers.length, losers: losers.length });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown server error";
    console.error("[cron/after-hours] Error:", errorMessage);
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
