// Copies harvested Gemini Deep Research reports into the private research corpus
// (~/.starlight/research/corpus) under engine-specific keys, so they never collide with the
// Perplexity reports (both live in a folder named `reports`, which the stock import key uses).
// Then `node corpus.mjs push` (research-intelligence-os) uploads to R2 and AI Search re-indexes.
// usage: node ingest.mjs            -> ingests every harvested report not yet in the corpus
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { sanitize } from '../untrusted.mjs';

// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = join(process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research'), 'gemini');
const corpus = join(process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research'), 'corpus');

// Report vertical/topic -> corpus domain (domains.json ids, plus the ai-for-science folder in use).
const DOMAIN = {
  'kb-01': 'ai-models-platforms', 'kb-02': 'ai-models-platforms', 'kb-03': 'ai-models-platforms',
  'kb-04': 'ai-models-platforms', 'kb-05': 'digital-product-design', 'kb-06': 'web-design',
  'kb-07': 'web-design', 'kb-08': 'marketing', 'kb-09': 'business-strategy', 'kb-10': 'community',
  'kb-11': 'ai-for-science', 'kb-12': 'ai-for-science', 'kb-13': 'ai-for-science', 'kb-14': 'ai-for-science',
  'kb-15': 'business-strategy', 'kb-16': 'ai-models-platforms', 'kb-17': 'ai-models-platforms',
  'kb-21': 'ai-models-platforms', 'kb-22': 'ai-models-platforms', 'kb-23': 'business-strategy',
  'kb-24': 'ai-for-science', 'kb-25': 'ai-for-science', 'kb-26': 'business-strategy', 'kb-27': 'ai-for-science',
  'kb-28': 'ai-for-science', 'kb-29': 'marketing', 'kb-36': 'ai-for-science', 'kb-37': 'business-strategy',
  'kb-38': 'ai-models-platforms', 'kb-39': 'ai-models-platforms',
};

const q = JSON.parse(readFileSync(join(here, 'queue.json'), 'utf8'));
let n = 0;
for (const f of readdirSync(join(here, 'reports')).filter((x) => x.endsWith('.md') && !x.endsWith('.chat.md'))) {
  const id = f.replace(/\.md$/, '');
  const domain = DOMAIN[id.slice(0, 5)];
  if (!domain) { console.error(`no domain for ${id}`); continue; }
  const target = join(corpus, domain, `gemini-dr-${id}.md`);
  const rawBody = readFileSync(join(here, 'reports', f), 'utf8').replace(/^---[\s\S]*?\n---\n/, '');
  const body = sanitize(rawBody).text;
  const item = q.items.find((x) => x.id === id) || {};
  const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? id).trim();
  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'source: gemini-deep-research',
    `source_chat: ${item.chat || 'unknown'}`,
    'kind: deep-research',
    `domain: ${domain}`,
    `topic_id: ${id}`,
    `imported: ${new Date().toISOString()}`,
    'verification: unverified-ai-synthesis',
    'trust: untrusted-web-derived',
    '---',
    '',
  ].join('\n');
  const next = fm + body;
  if (existsSync(target) && readFileSync(target, 'utf8').replace(/^imported: .*$/m, '') === next.replace(/^imported: .*$/m, '')) continue;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  console.log(`ingested ${domain}/gemini-dr-${id}.md`);
  n += 1;
}
console.log(`${n} new or changed`);
