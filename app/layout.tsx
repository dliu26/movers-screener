import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Movers Screener",
  description: "Real-time top gainers and losers for US stocks",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
