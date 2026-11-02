# Research corpus pipeline

Turns Gemini Deep Research reports, estate documents and live model catalogs into one searchable corpus that cloud agents and local CLI agents query the same way. Every new Claude Code session also starts with a brief: newest models, newest research, research that is due.

```text
 Google Drive (Deep Research)   estate / repo docs     provider model APIs
        │ rclone drive.readonly       │ import              │ brief
        ▼                             ▼                     ▼
   ~/.starlight/research/corpus/<domain>/*.md   (front matter: source, commit, kind, verification)
        │ push (wrangler r2 object put)
        ▼
   R2 starlight-research-corpus ──/sync──▶ AI Search "starlight-research" (built-in storage, hybrid + rerank)
                                                    │
                                   Worker starlight-research (bearer auth, fail closed)
                       /search · /ask (cited, Workers AI) · /status · /mcp
                         │                    │                         │
                Claude Code (HTTP MCP,   Codex / Grok / Gemini CLI   starlight-agents plane
                 headersHelper)          (stdio mcp-bridge.mjs)      (service binding, next)
```

## Why these choices

- **AI Search, created by the Worker's namespace binding.** `wrangler ai-search create` demands an AI Search service token for both R2 and built-in instances. A Worker with an `ai_search_namespaces` binding creates a built-in instance at runtime with no token, then copies R2 objects in through the Items API. AI Search handles chunking, embeddings, hybrid keyword and vector search, and reranking.
- **R2 stays the source of record** for the corpus; AI Search is a derived index that `/sync` rebuilds from it (`_sync/state.json` tracks etags). The `starlight-agents` Worker keeps its own `starlight-evidence` Vectorize index for mission evidence.
- **One Worker, many clients.** HTTP MCP for clients that support auth headers, a stdio bridge for those that don't, plain HTTP for scripts and Workers.
- **Code public, corpus private.** This repository is public. Titles, IDs and contents live in `~/.starlight/research` and the private bucket. The Worker refuses every request without the bearer token; `/health` reveals nothing.
- **Provenance on every document.** Deep Research and Gemini write-ups carry `verification: unverified-ai-synthesis`; local files carry their path and the commit they were read at, or `working-tree-draft` when uncommitted; model catalogs carry `measured-from-provider-api`. Answers from `/ask` cite source keys and repeat the label.

## Commands

| Command | Does |
|---|---|
| `node corpus.mjs list` · `classify` · `export` | Drive listing → inventory (kind, domain, re-run dedupe, personal exclusion) → markdown export |
| `node corpus.mjs import <f.md>... --domain <id>` | brings local or repo docs in with path and commit provenance |
| `node corpus.mjs push` | uploads changed files to R2 and triggers `/sync` |
| `node corpus.mjs sync` · `status` | Worker: copy R2 into AI Search · indexing state per item |
| `node corpus.mjs search "<q>" [--domain id]` | ranked passages with source keys |
| `node corpus.mjs ask "<q>" [--domain id]` | cited answer (model: `ANSWER_MODEL` in `worker/wrangler.jsonc`) |
| `node corpus.mjs brief` | session brief plus `_platform/latest-models.md` catalog in the corpus |
| `node corpus.mjs queue` | domains whose newest Deep Research report is past its window |
| `node corpus.mjs usage snapshot\|run\|show` | Gemini Deep Research usage ledger |

Tests: `node --test lib.test.mjs`.

## Clients

**Claude Code** (user scope, all projects):

```text
claude mcp add-json starlight-research '{"type":"http","url":"https://starlight-research.frankxai.workers.dev/mcp","headersHelper":"pwsh -NoProfile -File C:/Users/frank/.starlight/research/mcp-headers.ps1"}' --scope user
```

The header helper reads the token from `worker-secrets.env` at connect time, so no config file holds it.

**Codex, Grok CLI, Gemini CLI, Hermes**: run `mcp-bridge.mjs` as a stdio server (installed copy at `~/.starlight/research/bin/mcp-bridge.mjs`). Codex:

```toml
[mcp_servers.starlight-research]
command = "node"
args = ["C:/Users/frank/.starlight/research/bin/mcp-bridge.mjs"]
```

Tools: `research_search`, `research_ask`, `research_read`, `research_list`.

## Worker

`worker/` deploys with `wrangler deploy` (first deploy: `wrangler deploy --secrets-file ~/.starlight/research/worker-secrets.env`). Rotate the token by writing a new value to that file and running `wrangler secret put RESEARCH_TOKEN` with it; every client reads the file, so nothing else changes.

## Remaining one-time setup

1. `rclone config create gdrive drive scope=drive.readonly` (Google sign-in, read-only) to export Deep Research reports in bulk.
2. Optional: `pwsh -File register-daily.ps1` registers the daily refresh (staged, not registered).

## Session brief

A Claude Code SessionStart hook prints `~/.starlight/brief/session-brief.md`, so a new session knows the newest Workers AI and Vercel AI Gateway models (from their live catalogs, ranked by `released`), the newest research, the due domains and today's Deep Research usage, without a network call at start-up.

## Gemini usage

Since May 2026 Google no longer publishes a fixed Ultra Deep Research quota, and third-party figures conflict (120 and 200 per day). The ledger records the count the app shows and each run.

## NotebookLM

There is no NotebookLM API for consumer or Ultra accounts; the Enterprise API (Google Cloud, alpha) is the only official one, and unofficial clients need browser cookies, which this estate does not export. NotebookLM reads Drive Docs directly: one notebook per domain with the exported reports as sources.

## Deep Research prompts

`deep-research-prompts.md`: a shared frame and one block per domain, asking for dated primary sources, a claims table and a split between facts, forecasts and opinions.
