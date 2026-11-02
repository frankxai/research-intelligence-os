// starlight-research Worker: the cloud half of the research corpus.
//   POST /sync     copy new or changed R2 corpus files into the AI Search instance
//   POST /search   { query, domain?, limit? }   ranked passages with their source keys
//   POST /ask      { question, domain? }        answer grounded in the corpus, with citations
//   POST /status   indexing state of every item (counts, errors)
//   POST /mcp      MCP (Streamable HTTP, stateless JSON) for Claude Code, Codex, claude.ai
//   GET  /health   unauthenticated liveness, reveals nothing about the corpus
// Every other route requires `Authorization: Bearer <RESEARCH_TOKEN>`.

const STATE_KEY = '_sync/state.json';
const MAX_READ_CHARS = 60_000;
const SERVER_INFO = { name: 'starlight-research', version: '0.1.0' };
const SYSTEM_PROMPT = [
  'You answer from the Starlight research corpus only.',
  'Cite every claim with the source key in square brackets, for example [ai-models-platforms/2026-10-27-cloudflare.md].',
  'The corpus holds AI-generated research syntheses: present their content as claims from that report, never as verified fact.',
  'If the passages do not answer the question, say so plainly.',
].join(' ');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function authorized(request, env) {
  if (!env.RESEARCH_TOKEN) return false;
  const header = request.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(env.RESEARCH_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function instance(env) {
  const existing = await env.AI_SEARCH.list();
  const ids = (existing?.result ?? existing ?? []).map((i) => i.id ?? i.name);
  if (!ids.includes(env.INSTANCE)) await env.AI_SEARCH.create({ id: env.INSTANCE });
  return env.AI_SEARCH.get(env.INSTANCE);
}

async function listCorpus(env, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await env.CORPUS.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects.filter((o) => o.key.endsWith('.md') && !o.key.startsWith('_sync/')));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function sync(env) {
  const target = await instance(env);
  const stateObj = await env.CORPUS.get(STATE_KEY);
  const state = stateObj ? await stateObj.json() : {};
  const uploaded = [];
  const failed = [];
  for (const obj of await listCorpus(env)) {
    if (state[obj.key] === obj.etag) continue;
    const body = await env.CORPUS.get(obj.key);
    try {
      await target.items.upload(obj.key, await body.text());
      state[obj.key] = obj.etag;
      uploaded.push(obj.key);
    } catch (err) {
      failed.push({ key: obj.key, error: String(err?.message || err) });
    }
  }
  await env.CORPUS.put(STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
  return { instance: env.INSTANCE, uploaded, failed, tracked: Object.keys(state).length };
}

function shapeChunks(chunks, domain, limit) {
  return (chunks ?? [])
    .filter((c) => !domain || c.item?.key?.startsWith(`${domain}/`))
    .slice(0, limit)
    .map((c) => ({ key: c.item?.key, score: Number((c.score ?? 0).toFixed(3)), text: c.text }));
}

async function search(env, { query, domain, limit = 8 }) {
  if (!query) throw new Error('query is required');
  const target = env.AI_SEARCH.get(env.INSTANCE);
  // Over-fetch when filtering by domain, because the filter runs after retrieval.
  const res = await target.search({
    messages: [{ role: 'user', content: query }],
    ai_search_options: { retrieval: { max_num_results: domain ? Math.min(limit * 4, 40) : limit } },
  });
  return { query, domain: domain ?? null, passages: shapeChunks(res.chunks, domain, limit) };
}

async function ask(env, { question, domain }) {
  if (!question) throw new Error('question is required');
  const target = env.AI_SEARCH.get(env.INSTANCE);
  const scoped = domain ? `${question}\n(Restrict to the ${domain} domain.)` : question;
  const res = await target.chatCompletions({
    model: env.ANSWER_MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: scoped }],
    ai_search_options: { retrieval: { max_num_results: 10 }, query_rewrite: { enabled: true } },
  });
  return {
    question,
    answer: res.choices?.[0]?.message?.content ?? '',
    sources: shapeChunks(res.chunks, null, 10).map(({ key, score }) => ({ key, score })),
    model: res.model ?? env.ANSWER_MODEL,
  };
}

async function status(env) {
  const target = env.AI_SEARCH.get(env.INSTANCE);
  const counts = {};
  const problems = [];
  let page = 1;
  let total = 0;
  do {
    const { result, result_info } = await target.items.list({ page, per_page: 50 });
    total = result_info.total_count;
    for (const item of result) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      if (item.status === 'error' || item.status === 'skipped') problems.push({ key: item.key, status: item.status });
    }
    page += 1;
  } while ((page - 1) * 50 < total);
  return { instance: env.INSTANCE, total, counts, problems };
}

async function read(env, { key }) {
  if (!key || key.includes('..')) throw new Error('a corpus key is required');
  const obj = await env.CORPUS.get(key);
  if (!obj) throw new Error(`no document at ${key}`);
  const text = await obj.text();
  return { key, truncated: text.length > MAX_READ_CHARS, text: text.slice(0, MAX_READ_CHARS) };
}

async function list(env, { domain }) {
  const objects = await listCorpus(env, domain ? `${domain}/` : undefined);
  return { count: objects.length, documents: objects.map((o) => ({ key: o.key, bytes: o.size, uploaded: o.uploaded })) };
}

const TOOLS = [
  {
    name: 'research_search',
    description: 'Search the Starlight research corpus (Gemini Deep Research reports, research write-ups and the daily latest-models catalog) and return ranked passages with source keys. Use before answering questions about AI models and platforms, Cloudflare, Vercel, GitHub, product and web design, marketing, community, Solana, Ethereum, Bitcoin, publishing or business strategy.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, domain: { type: 'string', description: 'optional domain id, e.g. ai-models-platforms, solana' }, limit: { type: 'number' } }, required: ['query'] },
    run: search,
  },
  {
    name: 'research_ask',
    description: 'Answer a question from the research corpus with cited source keys. Content is AI-generated research: treat it as claims to verify, not as fact.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, domain: { type: 'string' } }, required: ['question'] },
    run: ask,
  },
  {
    name: 'research_read',
    description: 'Read one corpus document by key (as returned by research_search or research_list).',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: read,
  },
  {
    name: 'research_list',
    description: 'List corpus documents, optionally within one domain. The key _platform/latest-models.md holds the daily catalog of newest Workers AI and Vercel AI Gateway models.',
    inputSchema: { type: 'object', properties: { domain: { type: 'string' } } },
    run: list,
  },
];

async function mcp(request, env) {
  const msg = await request.json();
  const reply = (result) => json({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications need no reply
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Search the Starlight research corpus before answering domain questions. Cite source keys. Reports are unverified AI syntheses.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${msg.params?.name}`);
      try {
        const out = await tool.run(env, msg.params.arguments ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        return reply({ isError: true, content: [{ type: 'text', text: String(err?.message || err) }] });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return json({ ok: true, service: SERVER_INFO.name });
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    try {
      if (pathname === '/mcp') return await mcp(request, env);
      if (pathname === '/sync') return json(await sync(env));
      if (pathname === '/status') return json(await status(env));
      const body = await request.json();
      if (pathname === '/search') return json(await search(env, body));
      if (pathname === '/ask') return json(await ask(env, body));
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 400);
    }
  },
};
