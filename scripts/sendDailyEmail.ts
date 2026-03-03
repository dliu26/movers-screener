// scripts/sendDailyEmail.ts
// Local test runner for the daily movers email.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/sendDailyEmail.ts

import { fetchSnapshotAllTickers } from "@/lib/polygon";
import { enrichTickers, getCacheEntryOrEmpty } from "@/lib/marketCapCache";
import {
  MoverCard,
  ScoredTicker,
  CANDIDATE_COUNT,
  COMMON_STOCK_RE,
  derivePrice,
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

async function main(): Promise<void> {
  const to = process.env.DAILY_EMAIL_TO;
  if (!to) {
    console.error("DAILY_EMAIL_TO is not set in .env.local");
    process.exit(1);
  }
  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set in .env.local");
    process.exit(1);
  }

  console.log("Fetching snapshot data…");
  const { data: snapshotData } = await fetchSnapshotAllTickers();
  const tickers = snapshotData.tickers ?? [];
  console.log(`Snapshot: ${tickers.length} tickers`);

  // Score
  const scored: ScoredTicker[] = [];
  for (const snap of tickers) {
    if (!COMMON_STOCK_RE.test(snap.ticker)) continue;

    const price = derivePrice(snap);
    if (price === null) continue;

    const prevClose = snap.prevDay?.c;
    if (prevClose == null || prevClose === 0) continue;

    if (price < 0.10) continue;

    const changeAbs = price - prevClose;
    const changePct = (changeAbs / prevClose) * 100;

    if (changePct <= -99) continue;

    scored.push({ ticker: snap.ticker, price, changePct, changeAbs });
  }

  // Candidates
  const candidateGainers = [...scored]
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, CANDIDATE_COUNT);

  const candidateLosers = [...scored]
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, CANDIDATE_COUNT);

  const candidateSet = new Set<string>([
    ...candidateGainers.map((c) => c.ticker),
    ...candidateLosers.map((c) => c.ticker),
  ]);

  // Enrich
  console.log(`Enriching ${candidateSet.size} candidate tickers…`);
  await enrichTickers(Array.from(candidateSet));

  // Filter
  function hasMinCap(s: ScoredTicker): boolean {
    const { marketCap } = getCacheEntryOrEmpty(s.ticker);
    return marketCap !== null && marketCap >= MIN_MARKET_CAP;
  }

  const gainers = candidateGainers.filter(hasMinCap).slice(0, 50).map(buildCard);
  const losers = candidateLosers.filter(hasMinCap).slice(0, 50).map(buildCard);
  const asOf = new Date().toISOString();

  console.log(`Sending email to ${to}…`);
  const result = await sendViaResend(gainers, losers, asOf);

  if (result.ok) {
    console.log(`Sent: ${gainers.length} gainers, ${losers.length} losers`);
  } else {
    console.error("Failed to send email:", result.error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
