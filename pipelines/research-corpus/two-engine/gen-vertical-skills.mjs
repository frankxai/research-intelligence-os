// Generates one expert SKILL.md per vertical from the two-engine dossiers.
// The skill is short on purpose (progressive disclosure): it names when to use the expert, the
// consensus tooling with verified metadata, the evidence rules, and where the depth lives
// (dossiers on disk, full reports via the starlight-research MCP). It is not installed into
// ~/.claude/skills: estate rule keeps new skills out of the default prompt until they have an eval.
// usage: node gen-vertical-skills.mjs   (after build-verticals.mjs)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research');
const root = join(here, 'verticals');
const reg = JSON.parse(readFileSync(join(here, 'sources-registry.json'), 'utf8'));

const META = {
  'agent-infrastructure': { domain: 'ai-models-platforms', role: 'agent infrastructure architect', when: 'designing agent knowledge layers, memory, retrieval, multi-agent orchestration, agent security, evals, or choosing between Claude Code, Cloudflare Agents, Vercel AI SDK/Workflow and Google ADK' },
  'agentic-products': { domain: 'business-strategy', role: 'agentic product strategist', when: 'scoping MCP servers or agent-facing data products, pricing them, planning an agent-built venture, or packaging playbooks and managed agent teams' },
  design: { domain: 'digital-product-design', role: 'product design and agentic UI lead', when: 'designing agent interfaces (AG-UI, MCP Apps, generative UI), human-in-the-loop flows, or judging whether a surface meets a world-class design bar' },
  engineering: { domain: 'web-design', role: 'web performance engineer', when: 'diagnosing Core Web Vitals, choosing rendering and caching strategy on Vercel or Cloudflare, or setting performance budgets' },
  growth: { domain: 'marketing', role: 'growth, journey and retention strategist', when: 'mapping customer journeys, onboarding and activation, CLV and retention, AI-search discovery, or community design for a product' },
  science: { domain: 'ai-for-science', role: 'AI-for-science analyst (chemistry, physics, biology, materials)', when: 'assessing AI methods, models, datasets, autonomous labs or startup opportunities in a natural-science field' },
};

const consensus = (text) => {
  const block = text.split('## Consensus sources')[1]?.split('\n## ')[0] || '';
  return [...block.matchAll(/^\| \[([^\]]+)\]/gm)].map((m) => m[1].toLowerCase());
};

for (const v of readdirSync(root).filter((d) => existsSync(join(root, d, 'README.md')))) {
  const meta = META[v] || { domain: 'unrouted', role: `${v} expert`, when: `working on ${v}` };
  const topics = readdirSync(join(root, v)).filter((f) => /^kb-.*\.md$/.test(f));
  const topicRows = [];
  const repoCount = new Map();
  for (const f of topics) {
    const text = readFileSync(join(root, v, f), 'utf8');
    const engines = text.match(/^engines: \[(.*)\]$/m)?.[1] || '';
    const title = f.replace(/\.md$/, '');
    const cons = consensus(text);
    cons.forEach((r) => repoCount.set(r, (repoCount.get(r) || 0) + 1));
    topicRows.push(`| [${title}](${f}) | ${engines} | ${cons.length} |`);
  }
  const top = [...repoCount.keys()]
    .map((r) => reg.repos[r])
    .filter((x) => x && x.status === 'exists')
    .sort((a, b) => (b.stars || 0) - (a.stars || 0))
    .slice(0, 25)
    .map((x) => `| ${x.name} | ${x.stars} | ${x.pushed?.slice(0, 10)} | ${x.archived ? 'archived' : x.pushed < '2025-11-13' ? 'stale >1y' : 'active'} |`);

  const skill = [
    '---',
    `name: ${v}-expert`,
    `description: Use when ${meta.when}. Grounds answers in two-engine Deep Research (Gemini + Perplexity, Nov 2026) with existence-checked sources.`,
    '---',
    '',
    `# ${v} expert`,
    '',
    `Role: ${meta.role}. Your knowledge comes from two independent Deep Research engines run on the same questions in November 2026, merged into the dossiers beside this file. Treat that knowledge as unverified synthesis with checked sources: the repos and arXiv ids exist, but individual claims about them still need a primary-source check before they ship in anything public or priced.`,
    '',
    '## How to work',
    '',
    '1. Read the dossier for the topic at hand (table below). Start with "Consensus sources" and "Mental models", then the two engines\' stack recommendations side by side.',
    `2. For depth or a specific claim, query the private corpus: \`research_search\` / \`research_ask\` on the starlight-research MCP with domain \`${meta.domain}\`. Both engines' full reports are indexed there (keys \`gemini-dr-*\` and \`perplexity-dr-*\`).`,
    '3. Prefer what both engines agree on. Where they disagree, say so and show both positions rather than picking silently.',
    '4. Before recommending a dependency, re-check it live (`gh repo view`, Context7 for API usage). Metadata below was measured on the build date and goes stale.',
    '5. Label every claim: verified (primary source you opened), consensus (both engines), single-engine, or your own judgment.',
    '',
    '## Topics',
    '',
    '| Dossier | Engines | Consensus repos |',
    '|---|---|---|',
    ...topicRows,
    '',
    '## Consensus tooling across this vertical (by stars, measured on build date)',
    '',
    '| Repo | Stars | Last push | Health |',
    '|---|---|---|---|',
    ...top,
    '',
    '## Limits',
    '',
    '- Built from AI research syntheses; no human expert has reviewed this pack yet.',
    '- Source existence was checked mechanically (GitHub GraphQL, Semantic Scholar); claim accuracy was not.',
    '- Coverage is limited to the topics above. Say when a question falls outside them.',
    '',
    `_Generated ${new Date().toISOString()} by gen-vertical-skills.mjs._`,
    '',
  ].join('\n');
  writeFileSync(join(root, v, 'SKILL.md'), skill);
  console.log(`${v}: ${topics.length} topics, ${repoCount.size} consensus repos`);
}
