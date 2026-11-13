// Mechanical source check for Deep Research reports (Gemini + Perplexity).
// Extracts every cited GitHub repo and arXiv id, verifies them against GitHub GraphQL (batched,
// 40 repos per query) and the arXiv export API (batched id_list), and writes
// ~/.starlight/research/sources-registry.json plus a per-report summary.
// A report's claims are only as good as its sources: hallucinated repos or paper ids get flagged
// before any of it is distilled into an expert pack.
// usage: node verify-sources.mjs [reportsDir...]   (defaults: gemini/reports perplexity/reports)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research');
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [join(here, 'gemini', 'reports'), join(here, 'perplexity', 'reports')];
const regPath = join(here, 'sources-registry.json');
const reg = existsSync(regPath) ? JSON.parse(readFileSync(regPath, 'utf8')) : { repos: {}, papers: {} };

const NOT_REPO = new Set(['orgs', 'topics', 'features', 'marketplace', 'sponsors', 'collections', 'settings', 'about', 'pricing', 'enterprise', 'login', 'apps', 'search', 'trending', 'advisories', 'repos', 'users', 'notifications']);
const repoRe = /(?<![\w.])github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})/g;
const arxivRe = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?/g;

const reports = [];
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => /^kb-.*\.md$/.test(x) && !x.endsWith('.chat.md'))) {
    const text = readFileSync(join(d, f), 'utf8');
    const repos = new Set();
    const papers = new Set();
    for (const m of text.matchAll(repoRe)) {
      if (NOT_REPO.has(m[1].toLowerCase())) continue;
      repos.add(`${m[1]}/${m[2].replace(/\.git$/, '').replace(/[.)]+$/, '')}`.toLowerCase());
    }
    for (const m of text.matchAll(arxivRe)) papers.add(m[1]);
    reports.push({ engine: basename(dirname(d)), file: f, repos: [...repos], papers: [...papers] });
  }
}

// Stars, push dates and archive flags drift; a successful lookup older than REFRESH_DAYS is redone so
// generated skills and next-wave freshness checks do not act on stale metadata.
const REFRESH_DAYS = Number(process.env.SOURCES_REFRESH_DAYS || 14);
const stale = (e) => !e || (e.status === 'exists' && (Date.now() - Date.parse(e.checked || 0)) / 86400000 > REFRESH_DAYS);
const allRepos = [...new Set(reports.flatMap((r) => r.repos))].filter((r) => stale(reg.repos[r]));
const allPapers = [...new Set(reports.flatMap((r) => r.papers))].filter((p) => !reg.papers[p]);
console.log(`reports=${reports.length} new repos=${allRepos.length} new papers=${allPapers.length}`);

for (let i = 0; i < allRepos.length; i += 40) {
  const batch = allRepos.slice(i, i + 40);
  const body = batch.map((r, k) => {
    const [o, n] = r.split('/');
    return `r${k}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { nameWithOwner stargazerCount pushedAt isArchived description licenseInfo { spdxId } }`;
  }).join('\n');
  let res = {};
  try {
    res = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=query { ${body} }`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    // GraphQL returns partial data plus errors for missing repos; gh exits non-zero but prints JSON.
    try { res = JSON.parse(e.stdout?.toString() || ''); } catch { console.error(`batch ${i} failed: ${String(e.stderr || e).slice(0, 200)}`); continue; }
  }
  const data = res.data || {};
  // Only a per-alias NOT_FOUND error proves absence. Rate limits and other errors leave the repo
  // unrecorded, so the next run retries it instead of caching a false negative.
  const notFound = new Set((res.errors || []).filter((x) => x.type === 'NOT_FOUND').map((x) => x.path?.[0]));
  batch.forEach((r, k) => {
    const v = data[`r${k}`];
    if (v) reg.repos[r] = { status: 'exists', name: v.nameWithOwner, stars: v.stargazerCount, pushed: v.pushedAt, archived: v.isArchived, license: v.licenseInfo?.spdxId || null, description: v.description, checked: new Date().toISOString() };
    else if (notFound.has(`r${k}`)) reg.repos[r] = { status: 'not-found', checked: new Date().toISOString() };
  });
}

// Semantic Scholar batch lookup (free, unauthenticated, rate limited). A failed or throttled call
// leaves papers unchecked: a 429 is not evidence that a paper is fabricated.
async function lookupPapers(batch) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,year,citationCount', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: batch.map((p) => `ARXIV:${p}`) }),
    }).catch(() => null);
    if (res?.ok) return res.json();
    await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
  }
  return null;
}
for (let i = 0; i < allPapers.length; i += 100) {
  const batch = allPapers.slice(i, i + 100);
  const rows = await lookupPapers(batch);
  if (!rows) { console.error(`papers ${i}-${i + batch.length}: lookup throttled, left unchecked`); continue; }
  batch.forEach((p, k) => {
    const v = rows[k];
    reg.papers[p] = v
      ? { status: 'exists', title: v.title, year: v.year, citations: v.citationCount, checked: new Date().toISOString() }
      : { status: 'not-found', checked: new Date().toISOString() };
  });
}

writeFileSync(regPath, JSON.stringify(reg, null, 1));

const summary = reports.map((r) => {
  const rs = r.repos.map((x) => reg.repos[x]?.status);
  const ps = r.papers.map((x) => reg.papers[x]?.status);
  return {
    engine: r.engine, file: r.file,
    repos: r.repos.length, repos_missing: rs.filter((s) => s === 'not-found').length,
    papers: r.papers.length, papers_missing: ps.filter((s) => s === 'not-found').length,
  };
});
writeFileSync(join(here, 'sources-summary.json'), JSON.stringify(summary, null, 1));
console.table(summary);
