import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4 mb-5">
      <div>
        <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-muted mt-1 max-w-3xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, children, aside, className = "" }: { title?: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={`mb-7 ${className}`}>
      {title && (
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`bg-panel border border-line rounded-lg ${className}`}>{children}</div>;
}

/** Horizontal metric strip — real numbers only; null renders as "—". */
export function Metrics({ items }: { items: { label: string; value: ReactNode; hint?: string; tone?: "ok" | "warn" | "bad" }[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 border border-line rounded-lg overflow-hidden bg-panel">
      {items.map((m) => (
        <div key={m.label} className="px-4 py-3 border-r border-b border-line -mb-px">
          <div className="text-[11px] uppercase tracking-wider text-muted">{m.label}</div>
          <div className={`num text-[22px] font-semibold mt-0.5 ${m.tone === "ok" ? "text-ok" : m.tone === "warn" ? "text-warn" : m.tone === "bad" ? "text-bad" : ""}`}>{m.value ?? "—"}</div>
          {m.hint && <div className="text-[11px] text-faint mt-0.5">{m.hint}</div>}
        </div>
      ))}
    </div>
  );
}

const TONES: Record<string, string> = {
  ok: "text-ok border-ok/30 bg-ok/10",
  warn: "text-warn border-warn/30 bg-warn/10",
  bad: "text-bad border-bad/30 bg-bad/10",
  info: "text-info border-info/30 bg-info/10",
  accent: "text-accent border-accent/30 bg-accent/10",
  muted: "text-muted border-line-strong bg-panel-2",
};
export function Badge({ children, tone = "muted", title }: { children: ReactNode; tone?: keyof typeof TONES; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium border whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Button({ children, variant = "default", type = "submit", ...rest }: { children: ReactNode; variant?: "default" | "primary" | "danger" | "ghost" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls =
    variant === "primary"
      ? "bg-accent text-accent-ink border-accent hover:brightness-110"
      : variant === "danger"
        ? "text-bad border-bad/40 hover:bg-bad/10"
        : variant === "ghost"
          ? "border-transparent text-muted hover:text-text"
          : "border-line-strong hover:bg-panel-2";
  return (
    <button type={type} {...rest} className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium disabled:opacity-50 ${cls} ${rest.className ?? ""}`}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "default" }: { href: string; children: ReactNode; variant?: "default" | "primary" }) {
  return (
    <Link href={href} className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium ${variant === "primary" ? "bg-accent text-accent-ink border-accent" : "border-line-strong hover:bg-panel-2"}`}>
      {children}
    </Link>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="border border-dashed border-line-strong rounded-lg px-5 py-8 text-center text-muted">{children}</div>;
}

export function Bar({ value, max = 100, tone = "accent" }: { value: number | null | undefined; max?: number; tone?: "accent" | "ok" | "warn" | "bad" }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const bg = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" }[tone];
  return (
    <div className="h-1.5 w-full rounded bg-line overflow-hidden" aria-hidden>
      <div className={`h-full ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[13px]">
      <span className="text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

export const eur = (n: number | null | undefined, digits = 2) => (n == null ? "—" : new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: digits }).format(n));
export const pct = (n: number | null | undefined, digits = 1) => (n == null || isNaN(n) ? "—" : `${(n * 100).toFixed(digits).replace(".", ",")}%`);
export const nf = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("nl-NL").format(n));
export const dt = (d: Date | string | null | undefined) => (d ? new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" }).format(new Date(d)) : "—");
export const dd = (d: Date | string | null | undefined) => (d ? new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeZone: "Europe/Amsterdam" }).format(new Date(d)) : "—");
