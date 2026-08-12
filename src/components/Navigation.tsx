"use client";

import { Flame, Gamepad2, LayoutDashboard, Lightbulb, Radar, Settings, TrendingUp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/games", label: "Games", icon: Gamepad2 },
  { href: "/rising", label: "Rising", icon: Flame },
  { href: "/trends", label: "Trends", icon: TrendingUp },
  { href: "/ideas", label: "Idea Lab", icon: Lightbulb },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Navigation() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-mark"><Radar size={20} /></span>
        <span><span className="brand-title">Trend Radar</span><span className="brand-kicker">Roblox intelligence</span></span>
      </Link>
      <nav className="nav" aria-label="Main navigation">
        {links.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return <Link key={href} href={href} className={`nav-link ${active ? "active" : ""}`}><Icon size={18} /><span>{label}</span></Link>;
        })}
      </nav>
      <div className="sidebar-footer"><strong>Signal over size</strong><span>Scores prioritize velocity, freshness, acceleration, and propagation.</span></div>
    </aside>
  );
}
