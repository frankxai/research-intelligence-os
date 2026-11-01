# Research corpus pipeline

Turns Gemini Deep Research reports in Google Drive into a searchable corpus that both cloud agents and local CLI agents can query, and gives every new agent session a brief with the newest models, the newest research and the research that is due.

```text
Gemini Deep Research ──export to Docs──▶ Google Drive
                                            │  rclone (drive.readonly)
                                            ▼
                     ~/.starlight/research/corpus/<domain>/<date>-<slug>.md   (front matter: source, kind, verification)
                                            │  wrangler r2 object put
                                            ▼
                              R2 bucket: starlight-research-corpus
                                            │  automatic sync
                                            ▼
                    Cloudflare AI Search: starlight-research  (hybrid search + reranking)
                       │                    │                         │
             Workers binding        wrangler ai-search search     MCP endpoint (optional)
         (starlight-agents plane)   (corpus.mjs search, any CLI)
```

## Why these choices

- **AI Search over hand-built Vectorize ingestion.** AI Search chunks, embeds, indexes and keeps the R2 bucket in sync, with hybrid keyword and vector search plus reranking. Hand-rolling that on Vectorize would add code without adding capability for a document corpus. The `starlight-agents` Worker keeps its own `starlight-evidence` Vectorize index for mission evidence; the two serve different jobs.
- **R2 as the corpus store.** AI Search indexes R2 natively. The registry's media fabric puts web binaries on Vercel Blob; this corpus is agent context, never served to the web, so it is a documented R2 workload exception.
- **Code public, corpus private.** This repository is public. Titles, document IDs and contents live only in `~/.starlight/research` and the private bucket.
- **Every report is labelled `unverified-ai-synthesis`.** Deep Research is a model's reading of the web. Agents cite it as a claim with its source, never as measured fact. Short Gemini "Codex/Blueprint" write-ups are indexed as `gemini-canvas`, separate from research, because some of them contain invented run logs.

## Commands

| Command | Does |
|---|---|
| `node corpus.mjs list` | lists Drive root Docs through the `gdrive:` rclone remote |
| `node corpus.mjs classify [listing.json]` | writes `inventory.json`: kind, domain, duplicate, include |
| `node corpus.mjs export` | exports changed included Docs as markdown with front matter |
| `node corpus.mjs push` | uploads changed corpus files to R2 |
| `node corpus.mjs search "<question>"` | queries the AI Search instance |
| `node corpus.mjs brief` | writes `~/.starlight/brief/session-brief.md` and a heartbeat |
| `node corpus.mjs queue` | domains whose newest report is older than their window |
| `node corpus.mjs usage snapshot --remaining N` | records the Deep Research count shown in the Gemini app |
| `node corpus.mjs usage run --domain <id> --title "..."` | logs a Deep Research run |

`node --test lib.test.mjs` covers classification, duplicates, personal exclusion, staleness, usage and the brief.

Personal documents are excluded by generic markers plus private patterns in `~/.starlight/research/exclude.txt`.

## One-time setup

1. `rclone config create gdrive drive scope=drive.readonly` (opens a Google sign-in; read-only).
2. Create an AI Search service API token at `https://dash.cloudflare.com/<account>/ai/ai-search/tokens`.
3. `npx wrangler ai-search create starlight-research --type r2 --source starlight-research-corpus --reranking --hybrid-search --include-items "**/*.md"`.
4. Optional, after reading the security note below: enable the instance's MCP endpoint.
5. Optional: `pwsh -File register-daily.ps1` registers the daily refresh. It is staged, not registered.

**Security note on the MCP endpoint.** The AI Search public endpoint is reachable by anyone with the URL. The corpus holds private strategy, so keep it off and query through `wrangler` (authenticated by your Cloudflare login) or a Workers binding, until the endpoint sits behind Cloudflare Access.

## Session brief

A Claude Code SessionStart hook prints the cached brief, so a new session starts knowing the newest Workers AI and Vercel AI Gateway models (from their live catalogs), the newest research, the due domains and today's Deep Research usage. The brief costs no network call at session start; `brief` refreshes it.

## Gemini usage

Since May 2026 Google no longer publishes a fixed Ultra Deep Research quota, and third-party figures conflict (120 and 200 per day). The ledger therefore records what the app shows, plus each run, so planning uses observed numbers.

## NotebookLM

There is no NotebookLM API for consumer or Ultra accounts. The Enterprise API (Google Cloud, alpha) is the only official one, and unofficial clients work from browser cookies, which this estate does not export. NotebookLM reads Google Docs from Drive directly, so the workable path is one notebook per domain with the exported reports added as Drive sources.

## Deep Research prompts

`deep-research-prompts.md` has a shared frame and one block per domain. The frame asks for dated primary sources, a claims table and a split between facts, forecasts and opinions, which makes the report retrievable passage by passage.
