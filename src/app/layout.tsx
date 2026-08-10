import type { Metadata } from "next";
import { Navigation } from "@/components/Navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Roblox Trend Radar", template: "%s · Roblox Trend Radar" },
  description: "Growth-first Roblox game trend intelligence for solo developers.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><div className="app-shell"><Navigation /><main className="main"><header className="topbar"><span className="topbar-label">Market intelligence / Growth signals</span><span className="status-chip">Solo builder profile · 2–4 week scope</span></header>{children}</main></div></body></html>;
}
