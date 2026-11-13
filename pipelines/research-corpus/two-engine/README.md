# Two-engine Deep Research → expert verticals

Runs the same research questions through two independent Deep Research engines (Gemini and Perplexity), checks every cited source mechanically, and turns the result into per-topic dossiers and per-vertical expert skills. Code only: reports, queues, chat links and the source registry live in `RESEARCH_HOME` (default `~/.starlight/research`), never in this repository.

```text
Gemini Deep Research (BrowserOS)      Perplexity Deep Research (other lane)
        │ gemini/harvest.mjs                   │ (its own harvester)
        ▼                                      ▼
 RESEARCH_HOME/gemini/reports/kb-*.md   RESEARCH_HOME/perplexity/reports/kb-*.md
        │ gemini/ingest.mjs  ─────────────────────────────▶ corpus/<domain>/<engine>-dr-<id>.md
        │                                                    └─ corpus.mjs push → R2 → AI Search
        ▼
 verify-sources.mjs   GitHub GraphQL (40 repos/query) + Semantic Scholar batch → sources-registry.json
        ▼
 build-verticals.mjs  verticals/<vertical>/<id>.md  (consensus sources, single-engine sources,
                      each engine's deliverable sections side by side)
        ▼
 gen-vertical-skills.mjs  verticals/<vertical>/SKILL.md  (not installed until it has an eval)
```

## Why two engines

Agreement between independent engines plus a passing existence check is the confidence signal an expert agent leans on; anything only one engine says stays flagged. First measured pass (2026-11-13, 31 reports): 423 unique GitHub repos cited, 1 unresolved (a text-joining artifact, not a fabricated repo); 330 arXiv ids, all resolved. Existence is not claim accuracy, and the skills say so.

## Commands

| Command | Does |
|---|---|
| `node gemini/state.mjs next\|set <id> <status> [chat]\|list` | Gemini queue state and ledger |
| `node gemini/harvest.mjs <overflowFile> <id>` | BrowserOS panel read → `gemini/reports/<id>.md` (refuses < 1,500 words) |
| `node gemini/ingest.mjs` | copies reports into the corpus under `gemini-dr-*` keys, `verification: unverified-ai-synthesis` |
| `node verify-sources.mjs` | existence check; throttled lookups stay `unchecked`, never `not-found` |
| `node build-verticals.mjs` | two-engine dossiers and vertical indexes |
| `node gen-vertical-skills.mjs` | one expert `SKILL.md` per vertical |
| `node next-wave.mjs` | refinement: proposes the next wave per engine from the gaps (missing engine, < 5 consensus repos, > 20% stale sources, sanitiser flags) into `next-wave.json`; submits nothing |

All report text passes through `untrusted.mjs` (invisible and format characters, HTML comments, line-break normalisation, instruction-like phrases replaced in place) and is quoted inside dossiers; generated skills carry a trust-boundary rule.

`corpus.mjs import <f.md>... --domain <id> --kind deep-research --engine <name>` does the same keying for any other engine.

## Gemini Deep Research mechanics (measured 2026-11-13, Ultra plan)

- Select the tool through *Upload and tools → More tools → Deep Research*; the composer must show the `Deselect Deep Research` chip before send.
- Plans render only after the chat reloads when the tab is in the background; start each run from its chat URL.
- About 35 minutes per report, 6–10k words, 90–190 inline links.
- 15 runs used 100% of the rolling usage window and 15% of the weekly limit; the tool greys out with no reason given until the window resets.
- *Export to Docs* fails silently from a background tab; read the `deep-research-immersive-panel` element instead and upload the markdown to Drive as a Google Doc.
