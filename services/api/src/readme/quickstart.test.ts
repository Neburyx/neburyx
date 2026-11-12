import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Doc, REPOSITORY_ROOT } from '../testing/doc.js';
import { commandsOfBlock, inQuickstart, quickstartCommands, readme } from '../testing/quickstart.js';
import { reportLines } from '../source-test/command.js';
import { reportFromServer } from '../source-test/report.js';
import { baseSource, firstSource, load } from '../testing/mapping.js';

const demo = new Doc('deploy/demo/README.md');
const envExample = readFileSync(join(REPOSITORY_ROOT, 'deploy/demo/.env.example'), 'utf8');
const compose = parse(readFileSync(join(REPOSITORY_ROOT, 'deploy/demo/compose.yaml'), 'utf8')) as { services: Record<string, unknown> };
const composeText = readFileSync(join(REPOSITORY_ROOT, 'deploy/demo/compose.yaml'), 'utf8');

function sectionText(title: string): string {
  const start = readme.headings().find((heading) => heading.text === title);
  if (start === undefined) throw new Error(`no section ${title}`);
  const next = readme.headings().find((heading) => heading.line > start.line && heading.level <= start.level);
  return readme.lines.slice(start.line, (next?.line ?? readme.lines.length + 1) - 1).join('\n');
}

const flat = (text: string): string => text.replace(/\s+/g, ' ');

const COMMAND_WORDS = /^(docker|cd|cp|openssl) /;

function demoCommands(): Set<string> {
  const fenced = demo.blocks().filter((block) => block.info === 'bash').flatMap((block) => commandsOfBlock(block.text));
  const inline = demo.lines.flatMap((line) => (line.startsWith('```') ? [] : [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '').filter((span) => COMMAND_WORDS.test(span))));
  const keyMaking = [...envExample.matchAll(/openssl rand -(?:hex|base64) \d+/g)].map((match) => match[0]);
  return new Set([...fenced, ...inline, ...keyMaking]);
}

const SERVICES = Object.keys(compose.services);
const TROUBLESHOOTING = (command: string): boolean => command === 'docker compose ps' || (/^docker compose logs (\S+)$/.test(command) && SERVICES.includes(command.split(' ')[3] ?? ''));

const REQUIRED_COMMANDS = [
  'docker build -f deploy/docker/Dockerfile -t neburyx .',
  'cd deploy/demo',
  'cp .env.example .env',
  'docker compose up --wait',
  'docker compose run --rm --no-deps api test-source --name banking-demo',
  'docker compose run --rm --no-deps api test-source --name insurance-demo',
  'docker compose stop',
  'docker compose down -v',
];

describe('the Quickstart section', () => {
  it('is one heading, after the warning, and opens with what you need and says the data is synthetic', () => {
    expect(readme.lines.filter((line) => line === '## Quickstart')).toHaveLength(1);
    expect(readme.anchors().filter((anchor) => anchor === 'quickstart')).toHaveLength(1);
    const warning = readme.headings().find((heading) => heading.text.startsWith('Warning'));
    expect(readme.headings().find((heading) => heading.text === 'Quickstart')?.line ?? 0).toBeGreaterThan(warning?.line ?? Number.MAX_SAFE_INTEGER);
    const quickstartLine = readme.headings().find((heading) => heading.text === 'Quickstart')?.line ?? 0;
    const first = readme.headings().find((heading) => heading.level === 3 && heading.line > quickstartLine);
    expect(first?.text).toBe('What you need');
    expect(sectionText('Quickstart').toLowerCase()).toContain('synthetic');
    const figures = (text: string): string[] => [...text.matchAll(/\d,\d{3} MiB/g)].map((match) => match[0]).sort();
    expect(figures(demo.text)).toEqual(['3,911 MiB', '4,471 MiB']);
    expect(figures(sectionText('What you need'))).toEqual(figures(demo.text));
    const blocks = readme.blocks().filter((block) => /docker compose up/.test(block.text));
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('gives only commands the demo README gives, and every one of them', () => {
    const allowed = demoCommands();
    const given = quickstartCommands();
    const differing = given.filter((command) => !allowed.has(command) && !TROUBLESHOOTING(command));
    expect(differing).toEqual([]);
    for (const required of REQUIRED_COMMANDS) expect(given, required).toContain(required);
  });

  it('asks for exactly the settings that have no value in the example file, and makes values the way the file says', () => {
    const empty = envExample.split('\n').flatMap((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      return match !== null && (match[2] ?? '') === '' ? [match[1] ?? ''] : [];
    }).sort();
    expect(empty).toEqual(['DEMO_NEO4J_PASSWORD', 'NEBURYX_CURSOR_KEY', 'NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_APP_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD']);
    const section = sectionText('Fill in the settings');
    const named = [...section.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1] ?? '').sort();
    expect(named).toEqual(empty);
    expect(section).toContain('`openssl rand -hex 24`');
    expect(section).toContain('`openssl rand -base64 32`');
    expect(envExample).toContain('openssl rand -hex 24');
    expect(envExample).toContain('openssl rand -base64 32');
    expect(flat(section)).toContain('letters and digits only for passwords');
    expect(envExample).toContain('Use letters and digits only for passwords');
  });

  it('names the address, the port setting that changes it, and the first page', () => {
    const section = sectionText('Open the first page');
    expect(section).toContain('`http://127.0.0.1:8080`');
    expect(section).toContain('`NEBURYX_PORT`');
    expect(envExample).toContain('# NEBURYX_PORT=8080');
    expect(readFileSync(join(REPOSITORY_ROOT, 'deploy/compose/compose.yaml'), 'utf8')).toContain('127.0.0.1:${NEBURYX_PORT:-8080}:8080');
  });

  it('names each way the stack can fail to start, with a message only from the compose file', () => {
    const section = flat(sectionText('If the stack does not start'));
    expect(section).toContain('Port 8080 is in use');
    expect(section).toContain('set NEBURYX_CURSOR_KEY in the .env file');
    expect(composeText).toContain('${NEBURYX_CURSOR_KEY:?set NEBURYX_CURSOR_KEY in the .env file}');
    expect(section).toContain('image called `neburyx`');
    expect(composeText).toContain('${NEBURYX_DEMO_LOADER_IMAGE:-neburyx-demo-loader}');
    expect(section).toContain('enough memory');
    expect(section).toContain('docker compose ps');
    expect(SERVICES).toContain('api');
    expect(section).not.toMatch(/(port is already allocated|address already in use|bind for)/i);
  });

  it('says why no-deps is kept, that the read-only line is expected for the demo sources, and that up on a running stack resets the graphs', () => {
    const checks = flat(sectionText('Check the sources'));
    expect(checks).toContain('Keep `--no-deps`');
    expect(demo.text).toContain('Keep `--no-deps`');
    const source = firstSource(load(baseSource()));
    const report = reportFromServer(source, { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] }, null, '2026-11-02T10:00:00.000Z', {});
    const line = reportLines(report).split('\n').find((candidate) => candidate.startsWith('Read-only:'));
    expect(line).toBe('Read-only: not verified');
    expect(checks).toContain(`"${line}"`);
    const again = flat(sectionText('Stop, start again and remove'));
    expect(again).toContain('starts the loaders again and resets the graphs');
    expect(flat(demo.text)).toContain('starts the finished loaders again and resets the graphs');
  });

  it('has links that resolve, no query text and no private wording', () => {
    const links = readme.links().filter((link) => inQuickstart(link.line) && !/^[a-z]+:/.test(link.target) && !link.target.startsWith('../../'));
    for (const link of links) {
      const resolved = readme.resolveLink(link.target);
      expect([link.target, resolved.exists, resolved.anchorFound]).toEqual([link.target, true, true]);
    }
    const quickstart = sectionText('Quickstart');
    expect(readme.blocks().filter((block) => inQuickstart(block.line) && block.info.toLowerCase() === 'cypher')).toEqual([]);
    expect(quickstart.split('\n').filter((line) => /^\s*(MATCH|MERGE|CREATE|RETURN|CALL|WITH|UNWIND|DELETE|SET)\b/.test(line))).toEqual([]);
    expect(quickstart).not.toMatch(/\b(EP|OD|DM|F|B)-\d+(\.\d+)*\b|\b[DGQ]\d+\b|\bfound[e]r\b|\borchestrat[o]r\b/i);
  });
});

const GENERATOR = /^\[ -e \.env \] && echo "\.env exists; not overwritten" \|\| \( umask 077; cat > \.env <<EOF\n[\s\S]*\nEOF\n\)$/;

describe('the settings step and the failed-check line', () => {
  it('refuses a here-document that is never closed, instead of reading past it', () => {
    expect(() => commandsOfBlock('cat > .env <<EOF\nA=1\nEOF')).toThrow('is not closed');
    expect(commandsOfBlock('cd here\ncat > .env <<EOF\nA=1\nEOF\n)\nnext')).toEqual(['cd here', 'cat > .env <<EOF\nA=1\nEOF\n)', 'next']);
  });

  it('makes the generator the step and fills in by hand as the alternative after it', () => {
    const section = sectionText('Fill in the settings');
    const generator = readme.blocks().find((block) => inQuickstart(block.line) && GENERATOR.test(commandsOfBlock(block.text).find((command) => command.startsWith('[ -e .env ]')) ?? ''));
    expect(generator).toBeDefined();
    expect(commandsOfBlock(generator?.text ?? '')[0]).toBe('cd deploy/demo');
    expect(section.indexOf('cat > .env')).toBeGreaterThan(-1);
    expect(section.indexOf('Or fill it in by hand')).toBeGreaterThan(section.indexOf('cat > .env'));
    expect(section.indexOf('cp .env.example .env')).toBeGreaterThan(section.indexOf('Or fill it in by hand'));
    const demoStep = demo.text.indexOf('cat > .env');
    expect(demoStep).toBeGreaterThan(-1);
    expect(demo.text.indexOf('cp .env.example .env')).toBeGreaterThan(demoStep);
  });

  it('carries the generator command that the demo README carries, word for word', () => {
    const own = quickstartCommands().filter((command) => command.startsWith('[ -e .env ]'));
    expect(own).toHaveLength(1);
    expect(demoCommands().has(own[0] ?? '')).toBe(true);
  });

  it('tells the reader to run docker compose logs with the name of a service that is named after a setting, which is a service of the demo compose file', () => {
    const line = 'docker compose logs NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes';
    expect(SERVICES).toContain('NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes');
    expect(flat(sectionText('If the stack does not start'))).toContain(line);
    for (const text of [flat(sectionText('Start the demo')), flat(demo.text)]) {
      expect(text).toContain(line);
      expect(text).toContain("didn't complete successfully");
    }
  });
});

const BANKING_PACK = parse(readFileSync(join(REPOSITORY_ROOT, 'domain-packs/banking-fraud/neburyx.yaml'), 'utf8')) as { sources: { entities: { type: string; label: string; display?: { name?: string } }[]; derived: { id: string; from: string; to: string }[] }[] };
const INSURANCE_PACK = parse(readFileSync(join(REPOSITORY_ROOT, 'domain-packs/insurance-claims/neburyx.yaml'), 'utf8')) as { sources: unknown[] };

describe('the walk-through lines about derived links, the evidence panel and record links', () => {
  const WALK = flat(sectionText('Find the accounts that share a device') + sectionText('Ask why a link is there'));

  it('describes the two Linked Account rows with the client\'s own words, and the dashed style of a derived link', () => {
    const copy = readFileSync(join(REPOSITORY_ROOT, 'apps/web/src/inspector/copy.ts'), 'utf8');
    const rows = readFileSync(join(REPOSITORY_ROOT, 'apps/web/src/inspector/derived-rows.tsx'), 'utf8');
    const derivedText = readFileSync(join(REPOSITORY_ROOT, 'apps/web/src/inspector/derived-text.ts'), 'utf8');
    const evidence = readFileSync(join(REPOSITORY_ROOT, 'apps/web/src/evidence/copy.ts'), 'utf8');
    const renderer = readFileSync(join(REPOSITORY_ROOT, 'apps/web/src/canvas/cytoscape-renderer.ts'), 'utf8');
    expect(copy).toContain("export const LINKED = 'Linked';");
    expect(copy).toContain("export const RULE_DERIVED = 'rule-derived';");
    expect(rows).toContain('`${LINKED} ${name} · ${derivedCountText(result.count)}`');
    expect(derivedText).toContain(": 'Show'");
    expect(evidence).toContain("export const WHY_HERE = 'Why is this relationship here?';");
    expect(renderer).toMatch(/selector: 'edge\[origin = "derived"\]',\s*style: \{[^}]*'line-style': 'dashed'/);
    const banking = BANKING_PACK.sources[0];
    const sameType = banking?.derived.filter((rule) => rule.from === rule.to) ?? [];
    expect(sameType).toHaveLength(2);
    const type = banking?.entities.find((entity) => entity.type === sameType[0]?.from);
    const name = type?.display?.name ?? type?.label;
    for (const rule of sameType) expect(WALK).toContain(`the ${rule.id.replace(/-/g, ' ')}`);
    expect(WALK).toContain(`two "Linked ${name}" rows`);
    expect(WALK).toContain(`"Linked ${name} · N · rule-derived"`);
    expect(WALK).toContain('Press "Show" on a row');
    expect(WALK).toContain('Derived links are dashed.');
    expect(WALK).toContain('"Why is this relationship here?"');
  });

  it('says that selecting a relationship opens its evidence panel, and quotes the panel\'s title as the client names it', () => {
    expect(WALK).toContain('Selecting a relationship opens its evidence panel');
    expect(WALK).toContain('"Relationship evidence"');
    const panel = readFileSync(join(REPOSITORY_ROOT, 'apps/web/src/evidence/evidence-kit.tsx'), 'utf8');
    expect(panel).toContain("name: 'Relationship evidence'");
  });

  it('names every placeholder host of the demo packs\' record and evidence links, and says opening one fails and that your own source uses its mapping\'s template', () => {
    const hosts = new Set<string>();
    for (const pack of [BANKING_PACK, INSURANCE_PACK]) for (const url of JSON.stringify(pack).matchAll(/https:\/\/([a-z0-9.-]+)\//g)) hosts.add(url[1] ?? '');
    expect([...hosts].sort()).toEqual(['events.example.test', 'records.example.test']);
    for (const host of hosts) expect(WALK).toContain(`\`${host}\``);
    expect(WALK).toContain('opening one shows a load error: that is expected');
    expect(WALK).toContain('record links go to the link template that your mapping sets');
  });
});
