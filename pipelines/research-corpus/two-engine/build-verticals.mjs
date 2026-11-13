// Builds two-engine topic dossiers and vertical indexes from Gemini + Perplexity Deep Research.
// For each topic id present in either engine:
//   verticals/<vertical>/<id>.md  - consensus sources (cited by both engines, mechanically verified),
//                                   single-engine sources, and each engine's deliverable sections.
//   verticals/<vertical>/README.md - topic index with coverage and source-health numbers.
// Consensus across independent engines plus a passing existence check is the confidence signal an
// expert agent should lean on; single-engine claims stay flagged until a human or verifier confirms.
// usage: node build-verticals.mjs   (run verify-sources.mjs first)
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitize, inert, UNTRUSTED_NOTE } from './untrusted.mjs';

// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research');
const ENGINES = ['gemini', 'perplexity'];
const reg = JSON.parse(readFileSync(join(here, 'sources-registry.json'), 'utf8'));

const SECTIONS = [
  ['oss', /^#{2,3} .*(OSS|GitHub project|open-source project)/i],
  ['papers', /^#{2,3} .*(papers?)\b/i],
  ['models', /^#{2,3} .*(mental model|frameworks practitioners)/i],
  ['stack', /^#{2,3} .*(stack recommendation|solo founder)/i],
  ['open', /^#{2,3} .*open questions/i],
];
const LABEL = { oss: 'Top OSS projects', papers: 'Key papers', models: 'Mental models and frameworks', stack: 'Stack recommendation', open: 'Open questions' };

function frontMatter(raw) {
  // Normalise CRLF first: a Windows-saved report would otherwise lose its front matter and vertical.
  const text = raw.replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = {};
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { fm, body: m ? text.slice(m[0].length) : text };
}

function sections(body) {
  const lines = body.split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const hit = SECTIONS.find(([key, re]) => !out[key] && re.test(lines[i]));
    if (!hit) continue;
    const level = lines[i].match(/^#+/)[0].length;
    let j = i + 1;
    while (j < lines.length && !(lines[j].match(/^#+ /) && lines[j].match(/^#+/)[0].length <= level)) j += 1;
    out[hit[0]] = lines.slice(i + 1, j).join('\n').trim();
  }
  return out;
}

const repoRe = /(?<![\w.])github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})/g;
const arxivRe = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/g;
// Canonical identity (renames and transfers resolved), so an old slug in one engine and the new slug
// in the other still count as consensus.
const repos = (t) => new Set([...t.matchAll(repoRe)].map((m) => `${m[1]}/${m[2].replace(/\.git$/, '').replace(/[.)]+$/, '')}`.toLowerCase())
  .filter((r) => reg.repos[r]?.status === 'exists').map((r) => { const c = reg.repos[r].name?.toLowerCase(); return c && reg.repos[c] ? c : r; }));
const papers = (t) => new Set([...t.matchAll(arxivRe)].map((m) => m[1]));

const topics = new Map();
for (const engine of ENGINES) {
  const dir = join(here, engine, 'reports');
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => /^kb-\d+.*\.md$/.test(x) && !x.endsWith('.chat.md'))) {
    const id = f.replace(/\.md$/, '');
    const { fm, body: rawBody } = frontMatter(readFileSync(join(dir, f), 'utf8'));
    // Sanitise the whole report before splitting it, so section boundaries are found in the same
    // text that ends up in the dossier (no hidden characters or comments shifting a heading).
    const s = sanitize(rawBody);
    const body = s.text;
    // A harvester may already have sanitised the report and recorded its count in front matter;
    // that text is gone from the body, so add the recorded count rather than losing it.
    // Fail closed: only a non-negative integer is accepted; a malformed or negative value counts as
    // one flag instead of silently cancelling the scan's own count.
    const recorded = (v) => (v === undefined ? 0 : /^\d+$/.test(v) ? Number(v) : 1);
    const flagged = s.flagged + recorded(fm.injection_flags);
    const hidden = s.hidden + (/^\d+$/.test(fm.hidden_chars ?? '') ? Number(fm.hidden_chars) : 0);
    const t = topics.get(id) || { id, vertical: fm.vertical || 'unsorted', engines: {} };
    t.engines[engine] = { body, flagged, hidden, words: body.split(/\s+/).length, sections: sections(body), repos: repos(body), papers: papers(body) };
    topics.set(id, t);
  }
}

const fmtRepo = (r) => {
  const v = reg.repos[r];
  return `| [${v.name}](https://github.com/${v.name}) | ${v.stars ?? '?'} | ${v.pushed?.slice(0, 10) ?? '?'} | ${v.archived ? 'archived' : ''} | ${v.license ?? ''} |`;
};
const fmtPaper = (p) => {
  const v = reg.papers[p];
  const st = v?.status === 'exists' ? `${v.title} (${v.year ?? ''})` : v?.status === 'not-found' ? '**not found**' : 'unchecked';
  return `- [arXiv:${p}](https://arxiv.org/abs/${p}) ${st}`;
};

// Dossiers are fully derived: clear the previous build so a withdrawn or re-routed report cannot
// leave a stale dossier for gen-vertical-skills or next-wave to pick up. Hand-written files
// (SKILL.md is regenerated; docs-*.md briefs are kept) are not touched.
const vroot = join(here, 'verticals');
if (existsSync(vroot)) {
  for (const v of readdirSync(vroot)) {
    const d = join(vroot, v);
    for (const f of existsSync(d) ? readdirSync(d) : []) if (/^kb-.*\.md$/.test(f) || f === 'README.md') rmSync(join(d, f));
  }
}

const byVertical = new Map();
for (const t of [...topics.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  const have = ENGINES.filter((e) => t.engines[e]);
  const [g, p] = [t.engines.gemini, t.engines.perplexity];
  const both = g && p;
  const consensusRepos = both ? [...g.repos].filter((r) => p.repos.has(r)) : [];
  // Only verified papers count as existence-checked consensus; shared but unverified ids are listed apart.
  const sharedPapers = both ? [...g.papers].filter((x) => p.papers.has(x)) : [];
  const consensusPapers = sharedPapers.filter((x) => reg.papers[x]?.status === 'exists');
  const unverifiedShared = sharedPapers.filter((x) => reg.papers[x]?.status !== 'exists');
  const only = (e, kind) => (both ? [...t.engines[e][kind]].filter((x) => !t.engines[e === 'gemini' ? 'perplexity' : 'gemini'][kind].has(x)) : [...(t.engines[e]?.[kind] || [])]);
  // Counted from the sanitiser over each whole report, not from dossier text, so a flag in a part
  // of a report that never reaches the dossier still raises a human-review gap downstream.
  const flags = have.reduce((n, e) => n + t.engines[e].flagged, 0);
  const hiddenChars = have.reduce((n, e) => n + t.engines[e].hidden, 0);
  const out = [
    '---', `id: ${t.id}`, `vertical: ${t.vertical}`, `engines: [${have.join(', ')}]`,
    `built: ${new Date().toISOString()}`, 'verification: unverified-ai-synthesis; sources existence-checked', `injection_flags: ${flags}`, `hidden_chars: ${hiddenChars}`, '---', '',
    `# ${t.id}: two-engine dossier`, '',
    `Engines: ${have.map((e) => `${e} (${t.engines[e].words} words)`).join(', ')}. Full reports live in the private corpus (\`research_search\` / \`research_read\`).`, '',
    '## Consensus sources (cited by both engines, existence-checked)', '',
    both ? '| Repo | Stars | Last push | | License |\n|---|---|---|---|---|' : '_Only one engine has reported on this topic so far._',
    ...consensusRepos.sort((a, b) => (reg.repos[b].stars || 0) - (reg.repos[a].stars || 0)).map(fmtRepo), '',
    ...(consensusPapers.length ? ['Papers cited by both:', '', ...consensusPapers.map(fmtPaper), ''] : []),
    ...(unverifiedShared.length ? ['Cited by both but not verified (not found or unchecked; not consensus):', '', ...unverifiedShared.map(fmtPaper), ''] : []),
  ];
  for (const e of have) {
    out.push(`## Sources only ${e} cites`, '', '| Repo | Stars | Last push | | License |', '|---|---|---|---|---|',
      ...only(e, 'repos').sort((a, b) => (reg.repos[b].stars || 0) - (reg.repos[a].stars || 0)).map(fmtRepo), '',
      ...only(e, 'papers').map(fmtPaper), '');
  }
  // Reports written to a custom prompt have none of the five standard sections. Without this digest
  // the dossier reads as empty and editors conclude the corpus has no evidence on the topic.
  for (const e of have.filter((x) => Object.keys(t.engines[x].sections).length === 0)) {
    const body = t.engines[e].body;
    const outline = body.split('\n').filter((l) => /^#{1,3} /.test(l)).slice(0, 40).join('\n');
    // Skip every heading line, so a report that opens "# Title / ## Introduction" still yields prose.
    const lead = body.split('\n').filter((l) => !/^#{1,6} /.test(l)).join('\n').trim().split(/\s+/).slice(0, 450).join(' ');
    out.push(`## Report digest (${e})`, '',
      `This ${e} report does not use the five-section format, so the sections below are empty. It holds ${t.engines[e].words} words: read the full report before concluding the corpus lacks evidence.`, '',
      UNTRUSTED_NOTE, '', '### Outline', '', inert(outline || '_no headings_'), '', '### Opening', '', inert(lead), '');
  }
  for (const [key] of SECTIONS) {
    out.push(`## ${LABEL[key]}`, '');
    for (const e of have) {
      const text = t.engines[e].sections[key];
      out.push(`### ${e}`, '', UNTRUSTED_NOTE, '', text ? inert(text) : '_section not found in this report_', '');
    }
  }
  const vdir = join(here, 'verticals', t.vertical);
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, `${t.id}.md`), out.join('\n'));
  const row = { id: t.id, engines: have.join('+'), consensusRepos: consensusRepos.length, consensusPapers: consensusPapers.length, injectionFlags: flags };
  byVertical.set(t.vertical, [...(byVertical.get(t.vertical) || []), row]);
}

for (const [v, rows] of byVertical) {
  writeFileSync(join(here, 'verticals', v, 'README.md'), [
    `# Vertical: ${v}`, '',
    'Two-engine Deep Research dossiers (Gemini + Perplexity). Consensus = cited by both engines and existence-checked.', '',
    '| Topic | Engines | Consensus repos | Consensus papers |', '|---|---|---|---|',
    ...rows.map((r) => `| [${r.id}](${r.id}.md) | ${r.engines} | ${r.consensusRepos} | ${r.consensusPapers} |`), '',
  ].join('\n'));
}
console.table([...byVertical].flatMap(([v, rows]) => rows.map((r) => ({ vertical: v, ...r }))));
