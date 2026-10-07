"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import {
  BarChart3, Building2, CalendarCheck, Contact, Gauge, KanbanSquare, Lightbulb, Megaphone, Menu, Radar, Search, Settings,
} from "lucide-react";

const SECTIONS = [
  { title: "Overview", items: [{ href: "/", label: "Dashboard", icon: Gauge }] },
  {
    title: "Prospecting",
    items: [
      { href: "/discover", label: "Discover", icon: Search },
      { href: "/prospects", label: "Prospects", icon: Building2 },
      { href: "/opportunities", label: "Opportunities", icon: Lightbulb },
      { href: "/contacts", label: "Contacts", icon: Contact },
    ],
  },
  {
    title: "Sales",
    items: [
      { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
      { href: "/tasks", label: "Tasks", icon: CalendarCheck, badge: "tasks" as const },
      { href: "/campaigns", label: "Campaigns", icon: Megaphone },
    ],
  },
  { title: "Intelligence", items: [{ href: "/reports", label: "Reports", icon: BarChart3 }] },
];

export function Sidebar({ overdue, footer }: { overdue: number; footer: ReactNode }) {
  const path = usePathname();
  useEffect(() => document.body.classList.remove("nav-open"), [path]);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand">
        <span className="brand-mark"><Radar size={14} /></span> Venture Stream
      </div>
      {SECTIONS.map((s) => (
        <nav key={s.title} className="nav-section">
          <div className="nav-title">{s.title}</div>
          {s.items.map((i) => (
            <Link key={i.href} href={i.href} className={`nav-link${active(i.href) ? " active" : ""}`} aria-current={active(i.href) ? "page" : undefined}>
              <i.icon size={15} /> {i.label}
              {"badge" in i && overdue > 0 && <span className="badge danger nav-count" title="Overdue tasks">{overdue}</span>}
            </Link>
          ))}
        </nav>
      ))}
      <div className="sidebar-foot">
        <Link href="/settings" className={`nav-link${active("/settings") ? " active" : ""}`}>
          <Settings size={15} /> Settings
        </Link>
        {footer}
      </div>
    </aside>
  );
}

export function MenuButton() {
  return (
    <button className="btn icon ghost menu-btn" aria-label="Open navigation" onClick={() => document.body.classList.toggle("nav-open")}>
      <Menu size={17} />
    </button>
  );
}
