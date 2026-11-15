// Queue state for Gemini Deep Research runs.
// usage: node state.mjs next                -> prints next queued item (id + full prompt as JSON)
//        node state.mjs set <id> <status> [chatUrl]
//        node state.mjs list
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = join(process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research'), 'gemini');
const qPath = join(here, 'queue.json');
const q = JSON.parse(readFileSync(qPath, 'utf8'));
const [, , cmd, id, status, chat] = process.argv;

if (cmd === 'next') {
  const i = q.items.find((x) => x.status === 'queued');
  console.log(i ? JSON.stringify({ id: i.id, prompt: `${i.prompt} ${q.common_suffix}` }) : 'none');
} else if (cmd === 'set') {
  const i = q.items.find((x) => x.id === id);
  if (!i) { console.error(`unknown id ${id}`); process.exit(2); }
  i.status = status;
  if (chat) i.chat = chat;
  i[`${status}_at`] = new Date().toISOString();
  writeFileSync(qPath, JSON.stringify(q, null, 1));
  appendFileSync(join(here, 'ledger.jsonl'), JSON.stringify({ id, status, chat: i.chat, ts: new Date().toISOString() }) + '\n');
  console.log(`${id} -> ${status}`);
} else {
  for (const i of q.items) console.log(i.status.padEnd(9), i.id, i.chat || '');
}
