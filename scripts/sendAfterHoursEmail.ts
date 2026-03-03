// scripts/sendAfterHoursEmail.ts
// Local test for the after-hours email pipeline.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/sendAfterHoursEmail.ts

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

const MIN_MARKET_CAP = 500_000_000;

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

async function main(): Promise<void> {
  if (!process.env.DAILY_EMAIL_TO) {
    console.error("DAILY_EMAIL_TO is not set in .env.local");
    process.exit(1);
  }
  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set in .env.local");
    process.exit(1);
  }

  // After-hours start = 20:00 UTC today in nanoseconds
  const now = new Date();
  const afterHoursStartMs = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    20, 0, 0,
  );
  const afterHoursStartNs = afterHoursStartMs * 1_000_000;

  console.log("Fetching snapshot data…");
  const { data: snapshotData } = await fetchSnapshotAllTickers();
  const tickers = snapshotData.tickers ?? [];
  console.log(`Snapshot: ${tickers.length} tickers`);

  const scored: ScoredTicker[] = [];
  for (const snap of tickers) {
    if (!COMMON_STOCK_RE.test(snap.ticker)) continue;

    const lastTrade = snap.lastTrade;
    if (!lastTrade || lastTrade.t <= afterHoursStartNs) continue;

    const price = lastTrade.p;
    if (price < 0.10) continue;

    const prevClose = snap.day?.c;
    if (prevClose == null || prevClose === 0) continue;

    const changeAbs = price - prevClose;
    const changePct = (changeAbs / prevClose) * 100;
    if (changePct <= -99) continue;

    scored.push({ ticker: snap.ticker, price, changePct, changeAbs });
  }

  console.log(`Scored ${scored.length} after-hours tickers`);

  const candidateGainers = [...scored].sort((a, b) => b.changePct - a.changePct).slice(0, CANDIDATE_COUNT);
  const candidateLosers  = [...scored].sort((a, b) => a.changePct - b.changePct).slice(0, CANDIDATE_COUNT);

  const candidateSet = new Set<string>([
    ...candidateGainers.map((c) => c.ticker),
    ...candidateLosers.map((c) => c.ticker),
  ]);

  console.log(`Enriching ${candidateSet.size} candidate tickers…`);
  await enrichTickers(Array.from(candidateSet));

  const hasMinCap = (s: ScoredTicker) => {
    const { marketCap } = getCacheEntryOrEmpty(s.ticker);
    return marketCap !== null && marketCap >= MIN_MARKET_CAP;
  };

  const gainers = candidateGainers.filter(hasMinCap).slice(0, 50).map(buildCard);
  const losers  = candidateLosers.filter(hasMinCap).slice(0, 50).map(buildCard);
  const asOf    = new Date().toISOString();
  const subject = `After-Hours Movers — ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })}`;

  console.log(`Sending to ${process.env.DAILY_EMAIL_TO}…`);
  const result = await sendViaResend(gainers, losers, asOf, subject);

  if (result.ok) {
    console.log(`Sent: ${gainers.length} gainers, ${losers.length} losers`);
  } else {
    console.error("Failed:", result.error);
    process.exit(1);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
