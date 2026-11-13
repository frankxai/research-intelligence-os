// Turns a BrowserOS run overflow file (a Gemini Deep Research panel read) into a clean report.
// usage: node harvest.mjs <overflowFile> <id>
// The run must `return '=====REPORT-START=====\n' + markdown + '\n=====REPORT-END====='`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sanitize } from '../untrusted.mjs';

const [, , file, id] = process.argv;
if (!file || !id) { console.error('usage: harvest.mjs <file> <id>'); process.exit(2); }
// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = join(process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research'), 'gemini');
const q = JSON.parse(readFileSync(join(here, 'queue.json'), 'utf8'));
const item = q.items.find((x) => x.id === id);
if (!item) { console.error(`unknown id ${id}`); process.exit(2); }

const raw = readFileSync(file.replace(/^\\\\\?\\/, ''), 'utf8');
const start = raw.indexOf('=====REPORT-START=====');
const end = raw.lastIndexOf('=====REPORT-END=====');
if (start < 0 || end < 0) { console.error('markers not found'); process.exit(3); }
// The overflow file holds the run result as JSON; the slice between markers is JSON-escaped text.
let text = JSON.parse(`"${raw.slice(start + 22, end).replace(/^\\n/, '').replace(/\\n$/, '')}"`);
// BrowserOS's per-read nonce markers are replaced by a durable `trust:` field in the front matter;
// the text itself is sanitised (hidden characters, HTML comments, instruction-like lines flagged).
text = text.replace(/^\[UNTRUSTED_PAGE_CONTENT[^\n]*\n/, '').replace(/\n?\[END_UNTRUSTED_PAGE_CONTENT[^\]]*\]\s*$/, '').trim();
const { text: cleaned, flagged } = sanitize(text);
text = cleaned;

const words = text.split(/\s+/).length;
const links = (text.match(/\]\(https?:\/\//g) || []).length;
if (words < 1500) { console.error(`too short (${words} words): not a finished report`); process.exit(4); }

const out = join(here, 'reports', `${id}.md`);
mkdirSync(dirname(out), { recursive: true });
const fm = [
  '---',
  `id: ${id}`,
  `vertical: ${item.vertical}`,
  'source: gemini-deep-research',
  `chat: ${item.chat}`,
  `harvested: ${new Date().toISOString()}`,
  `words: ${words}`,
  `inline_links: ${links}`,
  'review_state: unverified',
  'trust: untrusted-web-derived',
  `injection_flags: ${flagged}`,
  '---',
  '',
].join('\n');
writeFileSync(out, fm + text + '\n');
execFileSync(process.execPath, [fileURLToPath(new URL('./state.mjs', import.meta.url)), 'set', id, 'harvested'], { stdio: 'inherit' });
console.log(JSON.stringify({ out, words, links, head: text.slice(0, 160) }));
