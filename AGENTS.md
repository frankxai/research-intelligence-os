# Research Intelligence OS — Agent Instructions

## Repository role

This repository is the reusable research-method engine. It owns runtime scaffolding, contracts, templates, schemas, provenance workflows, and evaluations for domain-specific research systems.

## Ownership boundary

- Owns: research workflow methods and reusable implementation primitives.
- Consumes by reference: papers, datasets, historical documents, and other source corpora.
- Does not own: the FrankX historical sacred-text corpus, Sacred Visions, translations or source editions governed elsewhere, or fictional Arcanea canon.
- A topic appearing in a workflow does not transfer ownership of that topic's source material here.

## Required preflight

Before adding a corpus, collection, product surface, or new repository boundary, load reviewed `frankxai/agentic-ops/registry/manifest.yaml`, record its commit SHA, check `exclusions.yaml`, and resolve `repositories.yaml` plus `artifact_authorities.yaml`. If no authority exists, stop at a proposal.

This boundary was clarified against Registry commit `81765d65fde9ed8692787425cfd1381a4f6dc40a`; always use the latest reviewed Registry commit.

## Work pattern

1. Read `README.md`, `research-os.yaml`, and relevant runtime contracts before editing.
2. Keep changes reusable across domains and preserve schema compatibility.
3. Never fabricate citations, provenance, evaluation evidence, or source content.
4. Test the smallest affected contract or evaluation before handoff.
