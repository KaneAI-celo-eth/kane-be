// Celopedia knowledge retrieval for the LLM assistant.
//
// The agent must ground in the FULL Celopedia knowledge base — not a tiny hardcoded slice — so
// this reads the actual reference markdown at runtime and injects the most relevant section(s)
// for each user query (lightweight keyword retrieval, section-level). Addresses the agent uses
// still come from the verified registry (celo-facts.ts); this adds broad protocol / yield /
// ecosystem knowledge so answers are grounded, current, and auto-synced with Celopedia.
//
// Path resolves to the workspace skill by default; override with CELOPEDIA_PATH for a deployed
// service that bundles a copy of the references.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_PATH = resolve(import.meta.dir, "../../.agents/skills/celopedia-skill/references");
const CELOPEDIA_PATH = process.env.CELOPEDIA_PATH ?? DEFAULT_PATH;

// DeFi-agent-relevant references (skip growth/marketing/minipay files the agent doesn't need).
const ALLOWLIST = [
  "network-info.md",
  "contracts.md",
  "defi-protocols.md",
  "ai-agents.md",
  "ecosystem.md",
  "attribution-tags.md",
  "security-patterns.md",
];

type Section = { file: string; heading: string; text: string };
const STOP = new Set(["the", "and", "for", "with", "you", "your", "what", "how", "can", "are", "this", "that", "celo", "onchain", "on-chain"]);

let cache: Section[] | null = null;

/** Load + section-split the allowlisted references (cached). Split on markdown headings. */
function sections(): Section[] {
  if (cache) return cache;
  cache = [];
  if (!existsSync(CELOPEDIA_PATH)) return cache;
  for (const file of ALLOWLIST) {
    const p = join(CELOPEDIA_PATH, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const part of text.split(/\n(?=#{1,3} )/)) {
      const body = part.trim();
      if (body.length < 20) continue;
      const heading = (body.match(/^#{1,3}\s+(.+)/)?.[1] ?? file).trim();
      cache.push({ file, heading, text: body });
    }
  }
  return cache;
}

/** Whether the Celopedia references are actually available on disk. */
export function celopediaAvailable(): boolean {
  return sections().length > 0;
}

/**
 * Retrieve the Celopedia section(s) most relevant to `query`, concatenated up to `maxChars`.
 * Scores each section by query-term frequency (+ a small boost when a term hits the heading).
 * Returns "" when nothing relevant is found or the references are unavailable.
 */
export function retrieveCelopedia(query: string, maxChars = 5000): string {
  const secs = sections();
  if (!secs.length) return "";
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
  if (!terms.length) return "";

  const scored = secs
    .map((s) => {
      const lc = s.text.toLowerCase();
      const hl = s.heading.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let i = lc.indexOf(t);
        while (i >= 0) {
          score++;
          i = lc.indexOf(t, i + t.length);
        }
        if (hl.includes(t)) score += 5; // heading match is a strong signal
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  let out = "";
  for (const { s } of scored) {
    const remaining = maxChars - out.length;
    if (remaining <= 200) break;
    const slice = s.text.length > remaining ? s.text.slice(0, remaining) + "\n…" : s.text;
    out += `\n\n### Celopedia · ${s.file} → ${s.heading}\n${slice}`;
  }
  return out.trim();
}
