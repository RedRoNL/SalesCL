"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/hq", label: "Sales Army HQ" },
  { href: "/prospects", label: "Prospectdatabase" },
  { href: "/research", label: "Onderzoekscentrum" },
  { href: "/market", label: "Marktinformatie" },
  { href: "/lists", label: "Weeklijsten" },
  { href: "/feedback", label: "Belbureau-feedback" },
  { href: "/settings", label: "Instellingen" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={`rounded-md px-3 py-1.5 text-[13px] ${active ? "bg-panel-2 text-text border-l-2 border-accent" : "text-muted hover:text-text hover:bg-panel-2/60"}`}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
