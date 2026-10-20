"use client";

import { LayoutDashboard, Radar } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [{ href: "/", label: "Overview", icon: LayoutDashboard }];

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
      <div className="sidebar-footer"><strong>Radar v2</strong><span>Collection is being rebuilt. The dashboard returns in phase 4.</span></div>
    </aside>
  );
}
