import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrendBoss',
  description: 'Read-only Hyperliquid perpetual level dashboard',
};

// Apply the saved theme before first paint to avoid a flash of the wrong theme.
const themeInit = `try{var t=localStorage.getItem('tb-theme');if(t==='light'||t==='dusk'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
