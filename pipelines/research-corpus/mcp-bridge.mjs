#!/usr/bin/env node
// stdio MCP bridge to the starlight-research Worker, for clients that speak stdio but not
// authenticated HTTP (Codex, Grok CLI, Gemini CLI, Hermes). Reads one JSON-RPC message per line
// on stdin, forwards it to <RESEARCH_URL>/mcp with the bearer token from RESEARCH_TOKEN or the
// private secrets file, and writes the reply as one line on stdout. Diagnostics go to stderr only.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const URL_BASE = process.env.RESEARCH_URL || 'https://starlight-research.frankxai.workers.dev';
const SECRETS = path.join(process.env.RESEARCH_HOME || path.join(homedir(), '.starlight', 'research'), 'worker-secrets.env');

function token() {
  if (process.env.RESEARCH_TOKEN) return process.env.RESEARCH_TOKEN;
  if (!existsSync(SECRETS)) return null;
  const line = readFileSync(SECRETS, 'utf8').split(/\r?\n/).find((l) => l.startsWith('RESEARCH_TOKEN='));
  return line ? line.slice('RESEARCH_TOKEN='.length).trim() : null;
}

const auth = token();
if (!auth) {
  process.stderr.write(`starlight-research bridge: no token in RESEARCH_TOKEN or ${SECRETS}\n`);
  process.exit(1);
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  try {
    const res = await fetch(`${URL_BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 202 || msg.id === undefined) return; // notification: no reply on stdio either
    const text = await res.text();
    if (!res.ok) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `worker HTTP ${res.status}: ${text.slice(0, 300)}` } });
    process.stdout.write(text.trim() + '\n');
  } catch (err) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `bridge: ${err.message}` } });
  }
}

// Replies may finish out of order; MCP matches them by id, so concurrency is safe.
createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim()) forward(line); });
