# Research to Working Systems
A Starlight Intelligence collaboration format for students, researchers and builders.

We build human-owned AI systems and turn research into software people can inspect, run and improve. This open method pack helps a small group take one paper or technical idea through a bounded experiment and a useful artifact.

## Contribute something useful
- Students: learn with a runnable starter, a source map and an evaluation. Public contribution is optional.
- Researchers: propose a reproducibility gap, documentation problem, small integration or evaluation task.
- Maintainers: identify an issue with a clear acceptance criterion and a review route.
- Hosts: provide audience, teaching context and a producer; propose a local or remote lab.
- Sponsors: fund learning access, compute or paid contribution work with explicit scope.

To propose a collaboration, [open an issue](https://github.com/frankxai/research-intelligence-os/issues/new) titled `Collaboration: <specific outcome>`. Include the public source, the actual problem, what would help, a bounded artifact, prerequisites, available supervision and any confirmed funding. Never place private contact details or unpublished research in a public issue.

A useful first request is “make this result easier to reproduce on this task set”, accompanied by a source and a clear failure case.

## Start here
- [90-minute lab and delivery standard](LAB.md)
- [Machine-readable translation record schema](translation.schema.json)
- [Synthetic example, deliberately unrun](example.json)

The schema distinguishes a proposed experiment, measured work, an upstream submission and an accepted contribution. A validator checks structure; it cannot authenticate receipts, establish scientific validity, authorise spending or confer affiliation. Human review remains responsible for those decisions.

## Contribution standard
Credit the original authors. Inspect the full source before making technical claims. Check code, model and data rights separately. Pin the experiment and publish failures, costs and limitations. Send fixes upstream when useful and welcomed; a PR is not accepted until the maintainer accepts it.

Students retain their work under the agreed project terms. Participation never requires marketing, an exclusive IP transfer or a contribution to our commercial product. Productive commercial missions require funded, explicit terms before work starts.

## Public evidence before prestige
Examples of relevant research directions, not partnerships:
- [UvA IRLab](https://ivi.uva.nl/research/information-retrieval-lab.html): conversational retrieval and evaluation.
- [MemoryArena on Stanford Digital Economy Lab](https://digitaleconomy.stanford.edu/publication/memoryarena-benchmarking-agent-memory-in-interdependent-multi-session-agentic-tasks/): evaluation of memory through interdependent agent tasks.
- [Kempner Open Source Hub](https://handbook.eng.kempnerinstitute.harvard.edu/s7_open_source_hub/README.html): open research engineering.

These links identify upstream work. No university endorsement, relationship, reproduction or comparative performance is claimed.

## Release state
Version 0.1 — authored method and schema; workshop not yet independently rehearsed. No agent runtime, scheduled ingestion, institutional directory, funding programme or live course is delivered by this folder.

This folder contains reusable methods. Institutional knowledge belongs in the existing Starlight Atlas authority; private relationship history and commercial records stay in their private systems.

[MIT licence](LICENSE) applies only to the newly authored files in this folder. Upstream works retain their own terms.

## Validate the structural contract
```bash
python -m pip install jsonschema==4.26.0
python -m unittest discover -s collaboration -p 'test_*.py'
```
No scheduled CI, paid compute or external runtime is activated by this pack.
