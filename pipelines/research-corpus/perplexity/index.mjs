// Builds INDEX.md: every harvested report grouped by vertical, plus queue coverage.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Private data lives outside the repo; this public code only reads and writes there.
const here = process.env.PERPLEXITY_HOME || join(homedir(), '.starlight', 'research', 'perplexity');
const reportsDir = join(here, 'reports');
const queue = JSON.parse(readFileSync(join(here, 'queue.json'), 'utf8'));

const frontMatter = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return Object.fromEntries(m[1].split('\n').map((l) => l.split(/:\s(.*)/s).slice(0, 2)));
};

const reports = readdirSync(reportsDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ file: f, ...frontMatter(readFileSync(join(reportsDir, f), 'utf8')) }))
  .map((r) => ({ ...r, words: Number(r.words || 0), links: Number(r.inline_links || 0) }));

// A full Deep Research document is long and heavily cited; chats and summaries are not.
const isFull = (r) => r.words >= 3000 && r.links >= 20;
const byVertical = Object.groupBy(reports, (r) => r.vertical || 'unsorted');
const done = new Set(reports.filter(isFull).map((r) => r.id));

const lines = [
  '# Perplexity Deep Research corpus',
  '',
  `Generated ${new Date().toISOString()}. Private; contents are unverified AI synthesis until a reviewer marks them.`,
  '',
  `Full reports: ${reports.filter(isFull).length} · Words: ${reports.filter(isFull).reduce((s, r) => s + r.words, 0)} · Source links: ${reports.filter(isFull).reduce((s, r) => s + r.links, 0)}`,
  '',
];
for (const [vertical, rs] of Object.entries(byVertical).sort()) {
  lines.push(`## ${vertical}`, '', '| Report | Words | Links | Type |', '|---|---|---|---|');
  for (const r of rs.sort((a, b) => b.words - a.words)) {
    lines.push(`| [${r.id}](reports/${r.file}) | ${r.words} | ${r.links} | ${isFull(r) ? 'full' : 'short'} |`);
  }
  lines.push('');
}
lines.push('## Queue coverage', '', '| Queue item | Vertical | Status |', '|---|---|---|');
for (const q of queue.items) lines.push(`| ${q.id} | ${q.vertical} | ${done.has(q.id) ? 'done' : 'open'} |`);

writeFileSync(join(here, 'INDEX.md'), lines.join('\n') + '\n');
console.log(`reports=${reports.length} full=${reports.filter(isFull).length} queueDone=${queue.items.filter((q) => done.has(q.id)).length}/${queue.items.length}`);
