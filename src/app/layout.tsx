import type { Metadata } from "next";
import { Navigation } from "@/components/Navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Roblox Trend Radar", template: "%s · Roblox Trend Radar" },
  description: "Roblox market radar: early breakouts, why they work, and room left in each cluster.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Navigation />
          <main className="main">
            <header className="topbar">
              <span className="topbar-label">Market intelligence / Radar v2</span>
              <span className="status-chip">Data core in progress</span>
            </header>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
