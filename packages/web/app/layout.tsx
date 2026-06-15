import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrendBoss TESTNET 5m',
  description: 'Live Hyperliquid TESTNET 5-minute trader dashboard',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
