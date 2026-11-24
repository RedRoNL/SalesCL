import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads vetted, pinned Agent Skills from .claude/skills/<name>/SKILL.md and
 * exposes their methodology to the production agent runtime. Skill content is
 * third-party but reviewed and version-pinned (see SKILLS.md); it is injected
 * as methodology reference, below Cloud Life's own rules.
 */
const cache = new Map<string, string | null>();
const SKILLS_DIR = path.join(process.cwd(), ".claude", "skills");

export function loadSkill(name: string, maxChars = 5000): string | null {
  const key = `${name}:${maxChars}`;
  if (cache.has(key)) return cache.get(key)!;
  const file = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) {
    cache.set(key, null);
    return null;
  }
  let body = readFileSync(file, "utf8");
  const fm = body.match(/^---\n([\s\S]*?)\n---\n/);
  const version = fm?.[1].match(/version:\s*([^\n]+)/)?.[1]?.trim() ?? "pinned";
  body = body.replace(/^---\n[\s\S]*?\n---\n/, "");
  if (body.length > maxChars) body = body.slice(0, maxChars) + "\n…[ingekort]";
  const out = `## Methodiek uit skill "${name}" (${version})\n${body}`;
  cache.set(key, out);
  return out;
}

export function skillExists(name: string): boolean {
  return existsSync(path.join(SKILLS_DIR, name, "SKILL.md"));
}
