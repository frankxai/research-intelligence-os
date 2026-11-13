// Writes full Perplexity reports into the private corpus under engine-specific keys
// (<domain>/perplexity-dr-<id>.md), so they never collide with the Gemini lane (gemini-dr-<id>.md)
// or with the stock import key (estate-<parentdir>-<file>.md).
// --migrate also removes this lane's earlier stock-import keys from R2 and moves the local copies to pruned/.
// Then run `node corpus.mjs push` in the pipeline copy.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Private data lives outside the repo; this public code only reads and writes there.
const here = process.env.PERPLEXITY_HOME || join(homedir(), '.starlight', 'research', 'perplexity');
// Same override as corpus.mjs, so the push reads the corpus this script writes.
const HOME = process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research');
const CORPUS = join(HOME, 'corpus');
const MANIFEST = join(HOME, 'push-manifest.json');
const BUCKET = 'starlight-research-corpus';

// Report vertical -> corpus domain (domains.json ids).
const DOMAIN = {
  'agent-infrastructure': 'ai-models-platforms',
  'agentic-products': 'agentic-income-streams',
  design: 'digital-product-design',
  engineering: 'web-design',
  growth: 'marketing',
  science: 'ai-for-science',
  industry: 'business-strategy',
};
const DOMAIN_OVERRIDE = { 'kb-10-community-building': 'community', 'kb-35-oss-distribution-agent-tools': 'github-ecosystem' };

const fm = (text) => Object.fromEntries((text.match(/^---\n([\s\S]*?)\n---/)?.[1] || '')
  .split('\n').map((l) => l.split(/:\s(.*)/s).slice(0, 2)));

const written = [];
for (const f of readdirSync(join(here, 'reports')).filter((f) => f.endsWith('.md') && !f.includes('.chat.'))) {
  const text = readFileSync(join(here, 'reports', f), 'utf8');
  const meta = fm(text);
  if (Number(meta.words) < 3000 || Number(meta.inline_links) < 20) continue;
  const domain = DOMAIN_OVERRIDE[meta.id] || DOMAIN[meta.vertical];
  if (!domain) { console.error(`skip ${f}: no domain for vertical ${meta.vertical}`); continue; }
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const title = body.match(/^# (.*)/m)?.[1] || meta.id;
  const head = ['---', `title: ${JSON.stringify(title)}`, 'source: perplexity-deep-research', `source_session: ${meta.session}`,
    'kind: deep-research', `domain: ${domain}`, `report_id: ${meta.id}`, `harvested: ${meta.harvested}`,
    'verification: unverified-ai-synthesis', '---', ''].join('\n');
  const key = `${domain}/perplexity-dr-${meta.id}.md`;
  mkdirSync(join(CORPUS, domain), { recursive: true });
  writeFileSync(join(CORPUS, key), head + body);
  written.push(key);
}
console.log(`wrote ${written.length} perplexity-dr docs`);

if (process.argv.includes('--migrate')) {
  const wrangler = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  // The estate-reports- prefix only says a file came from some reports/ directory, not from this lane.
  // A key is retired only when this run wrote its perplexity-dr replacement for the same report id
  // and the old file still exists in this lane's reports/ (same file name).
  const replaced = new Set(written.map((k) => k.replace(/^.*\/perplexity-dr-/, '').replace(/\.md$/, '')));
  const ours = new Set(readdirSync(join(here, 'reports')).map((f) => f.replace(/\.md$/, '')));
  const old = Object.keys(manifest).filter((k) => {
    const id = k.match(/\/estate-reports-((?:kb|prior)-[^/]+)\.md$/)?.[1];
    return id && replaced.has(id) && ours.has(id);
  });
  if (!old.length) console.log('migrate: nothing to retire (no estate-reports key has a replacement written this run)');
  for (const key of old) {
    execFileSync(wrangler, ['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'], { stdio: 'ignore', shell: process.platform === 'win32' });
    const target = join(HOME, 'pruned', key);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(join(CORPUS, key))) renameSync(join(CORPUS, key), target);
    delete manifest[key];
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(`migrated ${key}`);
  }
}
