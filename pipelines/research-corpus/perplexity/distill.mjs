// Distills full reports into per-vertical knowledge packs and a cross-report OSS citation index.
// Output: verticals/<vertical>/KNOWLEDGE-PACK.md, verticals/oss-index.json, verticals/OSS-INDEX.md
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Private data lives outside the repo; this public code only reads and writes there.
const here = process.env.PERPLEXITY_HOME || join(homedir(), '.starlight', 'research', 'perplexity');
const reportsDir = join(here, 'reports');
const outDir = join(here, 'verticals');

const KEEP = [
  ['summary', /^(executive|summary)/i],
  ['oss', /(oss|github|open[- ]source)/i],
  ['papers', /paper/i],
  ['models', /mental model|framework/i],
  ['stack', /stack/i],
  ['open', /open question/i],
];

const parse = (text) => {
  const fm = Object.fromEntries((text.match(/^---\n([\s\S]*?)\n---/)?.[1] || '')
    .split('\n').map((l) => l.split(/:\s(.*)/s).slice(0, 2)));
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const sections = body.split(/\n(?=## )/).map((s) => {
    const heading = s.match(/^## (.*)/)?.[1] || '';
    return { heading, text: s };
  });
  const title = body.match(/^# (.*)/m)?.[1] || fm.id;
  return { fm, title, sections, body };
};

const pick = (sections, re) => sections.find((s) => re.test(s.heading));

const files = readdirSync(reportsDir).filter((f) => f.endsWith('.md') && !f.includes('.chat.'));
const reports = files.map((f) => ({ file: f, ...parse(readFileSync(join(reportsDir, f), 'utf8')) }))
  .filter((r) => Number(r.fm.words) >= 3000 && Number(r.fm.inline_links) >= 20);

const oss = new Map();
const byVertical = Object.groupBy(reports, (r) => r.fm.vertical || 'unsorted');

for (const [vertical, rs] of Object.entries(byVertical)) {
  const lines = [`# ${vertical} knowledge pack`, '',
    'Distilled from Perplexity Deep Research reports. Status: unverified AI synthesis; check claims against the linked primary sources before relying on them.', ''];
  for (const r of rs) {
    lines.push(`---`, '', `# ${r.title}`, '', `Source report: \`reports/${r.file}\` · session ${r.fm.session}`, '');
    for (const [, re] of KEEP) {
      const s = pick(r.sections, re);
      if (s) lines.push(s.text.trim().replace(/^## /, '### '), '');
    }
    // Take the whole name segment, then drop only a trailing .git, so site.github.io stays intact.
    for (const m of r.body.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
      const repo = `${m[1]}/${m[2].replace(/\.git$/i, '').replace(/\.+$/, '')}`.toLowerCase();
      if (['orgs', 'topics', 'features', 'settings', 'search'].includes(m[1].toLowerCase())) continue;
      const e = oss.get(repo) || { repo, reports: new Set(), verticals: new Set() };
      e.reports.add(r.fm.id); e.verticals.add(vertical);
      oss.set(repo, e);
    }
  }
  mkdirSync(join(outDir, vertical), { recursive: true });
  writeFileSync(join(outDir, vertical, 'KNOWLEDGE-PACK.md'), lines.join('\n') + '\n');
}

const ranked = [...oss.values()]
  .map((e) => ({ repo: e.repo, reportCount: e.reports.size, reports: [...e.reports], verticals: [...e.verticals] }))
  .sort((a, b) => b.reportCount - a.reportCount || a.repo.localeCompare(b.repo));
writeFileSync(join(outDir, 'oss-index.json'), JSON.stringify(ranked, null, 2));
const md = ['# OSS cited across the research corpus', '', `${ranked.length} repositories, ranked by how many independent reports cite them.`, '',
  '| Repo | Reports | Verticals |', '|---|---|---|',
  ...ranked.map((e) => `| [${e.repo}](https://github.com/${e.repo}) | ${e.reportCount} | ${e.verticals.join(', ')} |`)];
writeFileSync(join(outDir, 'OSS-INDEX.md'), md.join('\n') + '\n');
console.log(`verticals=${Object.keys(byVertical).length} reports=${reports.length} repos=${ranked.length} multiCited=${ranked.filter((e) => e.reportCount > 1).length}`);
