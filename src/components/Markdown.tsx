import type { ReactNode } from "react";

/** Minimal, XSS-safe markdown (headings, lists, bold) rendered as React elements — never raw HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`ul${out.length}`}>{list}</ul>);
    list = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*[-*] /.test(line)) return list.push(<li key={i}>{inline(line.replace(/^\s*[-*] /, ""))}</li>);
    flush();
    if (/^#{1,4} /.test(line)) out.push(<h2 key={i}>{inline(line.replace(/^#{1,4} /, ""))}</h2>);
    else if (line.trim()) out.push(<p key={i}>{inline(line)}</p>);
  });
  flush();
  return <div className="prose-md text-[13px]">{out}</div>;
}
