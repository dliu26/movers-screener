// lib/email.ts
// HTML email builder and Resend sender for the daily movers digest.

import type { MoverCard } from "@/lib/moversCore";

// ─── HTML Builder ─────────────────────────────────────────────────────────────

function buildTableRows(cards: MoverCard[], isGainer: boolean): string {
  const color = isGainer ? "#16a34a" : "#dc2626";
  return cards
    .map((card) => {
      const sign = card.changePct >= 0 ? "+" : "";
      const absSign = card.changeAbs >= 0 ? "+" : "-";
      return `
        <tr>
          <td style="padding:6px 10px;font-family:monospace;font-weight:bold;color:#111;">${card.ticker}</td>
          <td style="padding:6px 10px;color:#444;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${card.name ?? "—"}</td>
          <td style="padding:6px 10px;font-family:monospace;text-align:right;color:#111;">$${card.price.toFixed(2)}</td>
          <td style="padding:6px 10px;font-family:monospace;text-align:right;color:${color};font-weight:600;">${sign}${card.changePct.toFixed(2)}%&nbsp;(${absSign}$${Math.abs(card.changeAbs).toFixed(2)})</td>
          <td style="padding:6px 10px;text-align:right;color:#555;">${card.marketCapFormatted}</td>
        </tr>`;
    })
    .join("\n");
}

function buildSection(title: string, cards: MoverCard[], isGainer: boolean): string {
  const headerBg = isGainer ? "#dcfce7" : "#fee2e2";
  const headerColor = isGainer ? "#15803d" : "#b91c1c";

  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border-collapse:collapse;margin-bottom:28px;font-size:13px;">
      <thead>
        <tr>
          <th colspan="5"
              style="padding:10px;background:${headerBg};color:${headerColor};
                     text-align:left;font-size:14px;font-weight:700;letter-spacing:0.02em;">
            ${title} (${cards.length})
          </th>
        </tr>
        <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
          <th style="padding:6px 10px;text-align:left;font-weight:600;color:#374151;">Ticker</th>
          <th style="padding:6px 10px;text-align:left;font-weight:600;color:#374151;">Name</th>
          <th style="padding:6px 10px;text-align:right;font-weight:600;color:#374151;">Price</th>
          <th style="padding:6px 10px;text-align:right;font-weight:600;color:#374151;">% Change</th>
          <th style="padding:6px 10px;text-align:right;font-weight:600;color:#374151;">Market Cap</th>
        </tr>
      </thead>
      <tbody>
        ${buildTableRows(cards, isGainer)}
      </tbody>
    </table>`;
}

export function buildEmailHtml(
  gainers: MoverCard[],
  losers: MoverCard[],
  asOf: string
): string {
  const asOfFormatted = new Date(asOf).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Daily Movers</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table width="680" cellpadding="0" cellspacing="0" border="0"
               style="background:#ffffff;border-radius:8px;overflow:hidden;
                      box-shadow:0 1px 3px rgba(0,0,0,0.1);max-width:100%;">

          <!-- Header -->
          <tr>
            <td style="padding:20px 24px;background:#111827;color:#f9fafb;">
              <p style="margin:0;font-size:20px;font-weight:700;letter-spacing:0.02em;">
                Daily Movers
              </p>
              <p style="margin:4px 0 0;font-size:12px;color:#9ca3af;">
                As of ${asOfFormatted}
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:24px;">
              ${buildSection("Top Gainers", gainers, true)}
              ${buildSection("Top Losers", losers, false)}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
                Market cap &ge; $500M &nbsp;&bull;&nbsp; Mid-cap &amp; above only
                &nbsp;&bull;&nbsp; Movers Screener
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Resend Sender ────────────────────────────────────────────────────────────

export async function sendViaResend(
  gainers: MoverCard[],
  losers: MoverCard[],
  asOf: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Movers Screener <noreply@resend.dev>",
        to: [process.env.DAILY_EMAIL_TO],
        subject: `Daily Movers — ${new Date().toLocaleDateString("en-US", {
          timeZone: "America/New_York",
        })}`,
        html: buildEmailHtml(gainers, losers, asOf),
      }),
    });

    if (res.status === 200 || res.status === 201) {
      return { ok: true };
    }

    const text = await res.text();
    return { ok: false, error: `Resend HTTP ${res.status}: ${text}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error sending email",
    };
  }
}
