"use client";

import { Activity, Radar, TrendingUp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Radar", icon: TrendingUp },
  { href: "/health", label: "Health", icon: Activity },
];

// Game pages open from the Radar, so they keep it highlighted.
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" || pathname.startsWith("/games/") : pathname.startsWith(href);
}

export function Navigation() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-mark"><Radar size={20} /></span>
        <span><span className="brand-title">Trend Radar</span><span className="brand-kicker">Roblox intelligence</span></span>
      </Link>
      <nav className="nav" aria-label="Main navigation">
        {links.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={`nav-link ${isActive(pathname, href) ? "active" : ""}`}><Icon size={18} /><span>{label}</span></Link>
        ))}
      </nav>
      <div className="sidebar-footer"><strong>Radar v2</strong><span>Classification and clusters arrive in phase 2.</span></div>
    </aside>
  );
}
