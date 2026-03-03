// app/api/cron/market-close/route.ts
// Fires at 21:10 UTC (4:10pm ET) on weekdays.
// Reports regular-session movers: day.c vs prevDay.c.

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

  try {
    // 1. Fetch snapshot
    const { data: snapshotData } = await fetchSnapshotAllTickers();
    const tickers = snapshotData.tickers ?? [];

    // 2. Score: use day.c as the closing price, prevDay.c as reference
    const scored: ScoredTicker[] = [];
    for (const snap of tickers) {
      if (!COMMON_STOCK_RE.test(snap.ticker)) continue;

      const price = snap.day?.c;
      if (price == null || price < 0.10) continue;

      const prevClose = snap.prevDay?.c;
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
    const subject = `Market Close Movers — ${new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
    })}`;
    const result = await sendViaResend(gainers, losers, asOf, subject);

    if (!result.ok) {
      console.error("[cron/market-close] Resend error:", result.error);
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    console.log(`[cron/market-close] Email sent — ${gainers.length} gainers, ${losers.length} losers`);
    return NextResponse.json({ ok: true, gainers: gainers.length, losers: losers.length });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown server error";
    console.error("[cron/market-close] Error:", errorMessage);
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  }
}
