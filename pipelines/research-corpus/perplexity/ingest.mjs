// Moves a Perplexity artifact download into reports/ with provenance.
// usage: node ingest.mjs "<downloaded file name in ~/Downloads>" <id> <sessionUrl> <vertical>
import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';

const [, , name, id, url, vertical = 'unsorted'] = process.argv;
if (!name || !id || !url) { console.error('usage: ingest.mjs <file> <id> <url> [vertical]'); process.exit(2); }
const src = join(homedir(), 'Downloads', name);
if (!existsSync(src)) { console.error(`missing ${src}`); process.exit(1); }

// Private data lives outside the repo; this public code only reads and writes there.
const here = process.env.PERPLEXITY_HOME || join(homedir(), '.starlight', 'research', 'perplexity');
for (const d of ['reports', 'raw']) mkdirSync(join(here, d), { recursive: true });
const ext = extname(name).toLowerCase();
const out = join(here, 'reports', `${id}${ext === '.md' ? '' : '.artifact'}${ext}`);
const ts = new Date().toISOString();
let words = 0, links = 0;

if (ext === '.md') {
  const text = readFileSync(src, 'utf8');
  words = text.split(/\s+/).length;
  links = (text.match(/\]\(https?:\/\//g) || []).length;
  const fm = ['---', `id: ${id}`, `vertical: ${vertical}`, 'source: perplexity-deep-research', `session: ${url}`,
    `artifact: ${JSON.stringify(name)}`, `harvested: ${ts}`, `words: ${words}`, `inline_links: ${links}`,
    'review_state: unverified', '---', ''].join('\n');
  writeFileSync(out, fm + text);
  renameSync(src, join(here, 'raw', name.replace(/[^\w.-]+/g, '_')));
} else {
  renameSync(src, out);
}
appendFileSync(join(here, 'ledger.jsonl'), JSON.stringify({ id, vertical, url, artifact: name, words, links, ts }) + '\n');
console.log(JSON.stringify({ out, words, links }));
