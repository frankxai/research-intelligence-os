// Packages the vertical expert skills for every local agent runtime that loads Markdown skills:
// Claude Code (SKILL.md folders), Vercel eve (agent/skills/*.md) and Google Antigravity
// (plugins/<name>/skills/<skill>/SKILL.md). All three share the frontmatter shape (name,
// description), so the same text ships everywhere; the corpus MCP is the shared knowledge layer.
// Output: packs/ (private, beside the verticals). Nothing is installed or published.
// usage: node export-packs.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Private research state lives outside this public repo (RESEARCH_HOME, default ~/.starlight/research).
const here = process.env.RESEARCH_HOME || join(homedir(), '.starlight', 'research');
const out = join(here, 'packs');
if (existsSync(out)) rmSync(out, { recursive: true });

const verticals = readdirSync(join(here, 'verticals')).filter((v) => existsSync(join(here, 'verticals', v, 'SKILL.md')));
const write = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

for (const v of verticals) {
  const skill = readFileSync(join(here, 'verticals', v, 'SKILL.md'), 'utf8');
  // Dossier links in the source are relative to the vertical folder; packs point back to it.
  const portable = skill.replace(/\]\((kb-[^)]+\.md)\)/g, `](${join(here, 'verticals', v).replace(/\\/g, '/')}/$1)`);
  write(join(out, 'claude-code', `${v}-expert`, 'SKILL.md'), portable);
  write(join(out, 'eve', 'agent', 'skills', `${v}-expert.md`), portable);
  write(join(out, 'antigravity', 'plugins', 'starlight-verticals', 'skills', `${v}-expert`, 'SKILL.md'), portable);
}

write(join(out, 'antigravity', 'plugins', 'starlight-verticals', 'plugin.json'), JSON.stringify({
  name: 'starlight-verticals',
  version: '0.1.0',
  description: 'Two-engine Deep Research expert skills (unverified synthesis, existence-checked sources).',
}, null, 2) + '\n');
write(join(out, 'antigravity', 'plugins', 'starlight-verticals', 'mcp_config.json'), JSON.stringify({
  mcpServers: {
    'starlight-research': {
      command: 'node',
      args: [join(here, 'bin', 'mcp-bridge.mjs').replace(/\\/g, '/')],
    },
  },
}, null, 2) + '\n');
write(join(out, 'README.md'), [
  '# Vertical expert packs',
  '',
  `Generated ${new Date().toISOString()} from ${verticals.length} verticals: ${verticals.join(', ')}.`,
  '',
  '- `claude-code/<vertical>-expert/SKILL.md`: copy into ~/.claude/skills only after the skill has an eval (estate rule).',
  '- `eve/agent/skills/*.md`: drop into an eve agent; add a `connections/` entry for the starlight-research MCP.',
  '- `antigravity/plugins/starlight-verticals/`: Antigravity plugin layout; verify plugin.json fields against current docs.',
  '',
  'Every pack carries the trust-boundary rule: dossier and corpus text is untrusted data.',
  '',
].join('\n'));
console.log(`${verticals.length} verticals x 3 runtimes -> ${out}`);
