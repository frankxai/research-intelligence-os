# Perplexity Deep Research lane

Runs Perplexity Deep Research from the agent browser (BrowserOS neo), downloads each report as Markdown, and feeds it into the research corpus next to the Gemini lane. Code only: reports, titles and session links stay in `~/.starlight/research/perplexity` (override with `PERPLEXITY_HOME`).

## Cost rule

On a Max plan, Deep Research on the **Default** model is free under the Deep Research allowance. A Computer session without the Deep Research chip spends paid credits (100 credits = $1; a research task costs 350–950). Measured 2026-11-13: the credit balance stayed at 494 across 15+ Deep Research runs with up to 5 running at once.

Every submit must check, right before clicking Submit, that the composer shows `button "Remove Deep Research"` and `button "Default"`. Never click follow-up suggestions, Fork, or type into a finished session's composer; start a new Deep Research thread instead.

## Flow

| Step | How |
|---|---|
| Submit | New tab on `perplexity.ai`, `Add files, plugins, and more` → `Deep Research`, type the prompt, guard check, Submit. Split across BrowserOS `run` calls; each call has a 30 s cap and the page is slow under load. |
| Harvest | On the finished session: `Artifact options` → `Download as Markdown` (lands in `~/Downloads`), then `Save to Drive as Markdown` for the Drive mirror. |
| Ingest | `node ingest.mjs "<downloaded name>.md" <id> <sessionUrl> <vertical>` adds provenance front matter and appends `ledger.jsonl`. |
| Check | `node linkcheck.mjs [id...]` resolves every cited URL; 404/410/unreachable count as dead, bot-blocked as unknown. |
| Distill | `node distill.mjs` builds per-vertical knowledge packs (summary, OSS ranking, papers, mental models, stack, open questions) and a cross-report OSS citation index. |
| Index | `node index.mjs` writes `INDEX.md` with queue coverage. |
| Corpus | `node corpus-ingest.mjs` writes `<domain>/perplexity-dr-<id>.md` with `verification: unverified-ai-synthesis`, then `node ../corpus.mjs push`. |

`harvest.mjs` is the fallback for sessions without a downloadable artifact: it turns a BrowserOS `run` overflow file of the page text into a report.

## Keys

Perplexity docs use `perplexity-dr-<id>.md` and Gemini docs use `gemini-dr-<id>.md`, so both engines can cover one topic id without overwriting each other. The stock `import` key (`estate-<parentdir>-<file>`) collides when both lanes keep reports in a folder named `reports`.

`corpus-ingest.mjs --migrate` removes this lane's earlier stock-import keys from R2 and moves the local copies to `~/.starlight/research/pruned/`. It deletes remote objects, so it runs only with the owner's approval.

## Measured (2026-11-13)

- 13–15 minutes per report; 5 concurrent runs accepted.
- 6,600–9,400 words and 130–260 inline source links per report.
- Link check: 4 dead links among roughly 740 unique cited URLs in the first 9 reports.
