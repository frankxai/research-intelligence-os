// Turns a BrowserOS run overflow file (a Perplexity session read) into a clean report.
// usage: node harvest.mjs <overflowFile> <id> <sessionUrl> [vertical]
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const [, , file, id, url, vertical = 'unsorted'] = process.argv;
if (!file || !id || !url) { console.error('usage: harvest.mjs <file> <id> <url> [vertical]'); process.exit(2); }

const raw = readFileSync(file.replace(/^\\\\\?\\/, ''), 'utf8');
const lit = raw.slice(raw.indexOf('return: ') + 8).trim();
let text = JSON.parse(lit);
text = text.replace(/^[\s\S]*?=====REPORT-START=====\n/, '').replace(/\n=====REPORT-END=====$/, '');
text = text.replace(/^\[UNTRUSTED_PAGE_CONTENT[^\n]*\n/, '').replace(/\n\[END_UNTRUSTED_PAGE_CONTENT[^\]]*\]\s*$/, '');

// Sidebar (teammates, projects, recents) precedes the session; recents end with "View all".
const cut = text.indexOf('View all');
if (cut > -1 && cut < 30000) text = text.slice(cut + 'View all'.length);
text = text.replace(/(Computer)+\s*$/, '').trim();

const words = text.split(/\s+/).length;
const links = (text.match(/\]\(https?:\/\//g) || []).length;
// Private data lives outside the repo; this public code only reads and writes there.
const here = process.env.PERPLEXITY_HOME || join(homedir(), '.starlight', 'research', 'perplexity');
const out = join(here, 'reports', `${id}.md`);
mkdirSync(dirname(out), { recursive: true });
const fm = [
  '---',
  `id: ${id}`,
  `vertical: ${vertical}`,
  `source: perplexity-deep-research`,
  `session: ${url}`,
  `harvested: ${new Date().toISOString()}`,
  `words: ${words}`,
  `inline_links: ${links}`,
  `review_state: unverified`,
  '---',
  '',
].join('\n');
writeFileSync(out, fm + text + '\n');
appendFileSync(join(here, 'ledger.jsonl'), JSON.stringify({ id, vertical, url, words, links, ts: new Date().toISOString() }) + '\n');
console.log(JSON.stringify({ out, words, links, head: text.slice(0, 200) }));
