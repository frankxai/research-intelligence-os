// Refinement step: reads the two-engine dossiers and the source registry, finds where the knowledge
// base is weak, and proposes the next research wave for each engine. This is how the pipeline
// improves itself between runs without a human picking topics by taste.
// Gaps it looks for, per topic:
//   missing-engine   only one engine has reported -> run the same prompt on the other engine
//   low-consensus    both reported but share < 5 verified repos -> targeted reconciliation prompt
//   stale-sources    > 20% of cited repos archived or not pushed in a year -> freshness prompt
//   flagged          sanitiser flagged instruction-like text -> human look before reuse
// Output: next-wave.json (proposals only; nothing is submitted automatically).
// usage: node next-wave.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research');
const reg = JSON.parse(readFileSync(join(here, 'sources-registry.json'), 'utf8'));
const queues = Object.fromEntries(['gemini', 'perplexity'].map((e) => {
  const p = join(here, e, 'queue.json');
  return [e, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { items: [] }];
}));
const promptFor = (id) => {
  for (const q of Object.values(queues)) {
    const i = q.items.find((x) => x.id === id);
    if (i) return i.prompt;
  }
  return null;
};
const YEAR_AGO = new Date(Date.now() - 365 * 864e5).toISOString();
const repoRe = /\| \[([^\]]+)\]\(https:\/\/github\.com/g;

const proposals = [];
for (const v of readdirSync(join(here, 'verticals'))) {
  const dir = join(here, 'verticals', v);
  if (!existsSync(join(dir, 'README.md'))) continue;
  for (const f of readdirSync(dir).filter((x) => /^kb-.*\.md$/.test(x))) {
    const id = f.replace(/\.md$/, '');
    const text = readFileSync(join(dir, f), 'utf8');
    const engines = (text.match(/^engines: \[(.*)\]$/m)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const consensusBlock = text.split('## Consensus sources')[1]?.split('\n## ')[0] || '';
    const consensus = [...consensusBlock.matchAll(repoRe)].map((m) => m[1].toLowerCase());
    const allRepos = [...new Set([...text.matchAll(repoRe)].map((m) => m[1].toLowerCase()))];
    const stale = allRepos.filter((r) => { const x = reg.repos[r]; return x && (x.archived || (x.pushed && x.pushed < YEAR_AGO)); });
    const base = promptFor(id);

    if (engines.length === 1) {
      const missing = engines[0] === 'gemini' ? 'perplexity' : 'gemini';
      proposals.push({ id, vertical: v, engine: missing, gap: 'missing-engine', priority: 1, prompt: base, why: `only ${engines[0]} has reported` });
    } else if (consensus.length < 5) {
      proposals.push({
        id: `${id}-reconcile`, vertical: v, engine: 'either', gap: 'low-consensus', priority: 2,
        prompt: `Reconciliation pass on: ${base ?? id}. Two independent research reports on this topic agreed on only ${consensus.length} open-source projects. For each candidate tool or repository in this field, state whether it is actively maintained (last commit, release), who uses it in production (named organisations with sources), and whether a newer project has replaced it. End with a ranked, evidence-backed shortlist and say which claims could not be verified.`,
        why: `${consensus.length} consensus repos`,
      });
    }
    if (allRepos.length && stale.length / allRepos.length > 0.2) {
      proposals.push({
        id: `${id}-freshness`, vertical: v, engine: 'either', gap: 'stale-sources', priority: 3,
        prompt: `Freshness check for ${id}: these cited projects look archived or inactive for over a year: ${stale.slice(0, 12).join(', ')}. For each, find the maintained successor or confirm it is still the reference, with primary sources dated 2026.`,
        why: `${stale.length}/${allRepos.length} cited repos stale or archived`,
      });
    }
    // Counted by the sanitiser over each whole report (dossier front matter), not by searching the
    // dossier text. A dossier without the count predates the field: fail closed.
    const injectionFlags = Number(text.match(/^injection_flags: (\d+)$/m)?.[1] ?? NaN);
    if (injectionFlags !== 0) {
      const why = Number.isNaN(injectionFlags) ? 'no injection_flags count; rebuild the dossier' : `${injectionFlags} sanitiser flag(s); review the original reports before reuse`;
      proposals.push({ id, vertical: v, engine: 'human', gap: 'flagged', priority: 1, prompt: null, why });
    }
  }
}
proposals.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
writeFileSync(join(here, 'next-wave.json'), JSON.stringify({ generated: new Date().toISOString(), proposals }, null, 1));
console.table(proposals.map(({ id, engine, gap, why }) => ({ id, engine, gap, why })));
