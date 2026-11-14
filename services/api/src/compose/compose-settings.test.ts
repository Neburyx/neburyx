import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { repository } from './stack.js';

interface Service {
  readonly environment?: Record<string, string>;
  readonly volumes?: readonly string[];
}

const services = (file: string): Record<string, Service> => (parse(readFileSync(join(repository, file), 'utf8'), { logLevel: 'silent' }) as { services: Record<string, Service> }).services;
const community = services('deploy/compose/compose.yaml');
const demo = services('deploy/demo/compose.yaml');
const example = readFileSync(join(repository, 'deploy/compose/.env.example'), 'utf8');

const API_SETTINGS = ['NEBURYX_PROFILE', 'NEBURYX_AI_CACHE', 'NEBURYX_AI_CACHE_TTL', 'NEBURYX_DATABASE_CONNECT_TIMEOUT_MS', 'NEBURYX_READINESS_LIMIT_MS'];
const ASK_SETTINGS = ['NEBURYX_ASK_PROVIDER', 'NEBURYX_ASK_CLASSIFICATION_MODEL', 'NEBURYX_ASK_EFFORT', 'NEBURYX_ASK_TIMEOUT_MS', 'NEBURYX_ASK_MAX_RETRIES', 'NEBURYX_ASK_MAX_TOKENS'];
const MIGRATE_SETTINGS = ['NEBURYX_PROFILE', 'NEBURYX_DATABASE_CONNECT_TIMEOUT_MS'];
const MAPPING_MOUNT = '${NEBURYX_CONFIG_DIR:-./config}:/etc/neburyx:ro';

describe('the settings the Community compose file passes', () => {
  it('gives the api service the profile, the cache settings and the two database limits, each with an empty default', () => {
    for (const name of API_SETTINGS) expect(community['api']?.environment?.[name], name).toBe(`\${${name}:-}`);
  });

  it('gives the api service the settings of Ask with an empty default, and the folder of intents at a fixed path in the mounted config folder', () => {
    for (const name of ASK_SETTINGS) expect(community['api']?.environment?.[name], name).toBe(`\${${name}:-}`);
    expect(community['api']?.environment?.['NEBURYX_ASK_MAPPING_FOLDER']).toBe('/etc/neburyx/ask');
    expect(community['api']?.volumes).toContain(MAPPING_MOUNT);
  });

  it('passes the key of Ask by no name: it comes from source.env', () => {
    const text = readFileSync(join(repository, 'deploy/compose/compose.yaml'), 'utf8');
    expect(text).not.toMatch(/NEBURYX_ASK_API_KEY/);
  });

  it('gives the migrate service none of the settings of Ask', () => {
    for (const name of [...ASK_SETTINGS, 'NEBURYX_ASK_MAPPING_FOLDER', 'NEBURYX_ASK_API_KEY', 'NEBURYX_ASK_API_KEY_FILE']) expect(community['migrate']?.environment, name).not.toHaveProperty(name);
  });

  it('gives the migrate service the profile and the connect limit with an empty default, and neither the cache settings nor the readiness limit', () => {
    for (const name of MIGRATE_SETTINGS) expect(community['migrate']?.environment?.[name], name).toBe(`\${${name}:-}`);
    for (const name of ['NEBURYX_AI_CACHE', 'NEBURYX_AI_CACHE_TTL', 'NEBURYX_READINESS_LIMIT_MS']) expect(community['migrate']?.environment, name).not.toHaveProperty(name);
  });

  it('gives migrate the mapping the way api has it: the same path and the same read-only mount', () => {
    expect(community['migrate']?.environment?.['NEBURYX_CONFIG']).toBe('/etc/neburyx/neburyx.yaml');
    expect(community['api']?.environment?.['NEBURYX_CONFIG']).toBe(community['migrate']?.environment?.['NEBURYX_CONFIG']);
    expect(community['migrate']?.volumes).toEqual([MAPPING_MOUNT]);
    expect(community['api']?.volumes).toContain(MAPPING_MOUNT);
  });

  it('holds no secret, and no default other than empty, for a setting', () => {
    const text = readFileSync(join(repository, 'deploy/compose/compose.yaml'), 'utf8');
    for (const name of [...API_SETTINGS, ...ASK_SETTINGS]) expect(text).not.toMatch(new RegExp(`\\$\\{${name}:-[^}]`));
  });

  it('lists the five in the settings example as optional, commented out, each with a description above it', () => {
    const lines = example.split('\n');
    for (const name of API_SETTINGS) {
      const at = lines.findIndex((line) => line === `# ${name}=`);
      expect(at, name).toBeGreaterThan(0);
      const above = lines[at - 1] ?? '';
      expect(above.startsWith('# ') && !/^# [A-Z][A-Z0-9_]+=/.test(above), name).toBe(true);
    }
    expect(example).not.toMatch(/^NEBURYX_(PROFILE|AI_CACHE|AI_CACHE_TTL|DATABASE_CONNECT_TIMEOUT_MS|READINESS_LIMIT_MS)=/m);
  });
});

describe('the demo compose file', () => {
  it('has the migrate service read no mapping, since the demo makes its own for the api', () => {
    expect(demo['migrate']?.environment?.['NEBURYX_CONFIG']).toBe('');
    expect(demo['migrate']?.volumes).toEqual([]);
  });

  it('holds nothing of Ask that switches it on: no key file, no key mount and no folder of the demo\'s own', () => {
    const text = readFileSync(join(repository, 'deploy/demo/compose.yaml'), 'utf8');
    expect(text).not.toMatch(/NEBURYX_ASK_API_KEY|NEBURYX_DEMO_ASK_KEY_FILE|\/run\/ask|--ask|enterprise/);
  });
});

interface OverrideService {
  readonly command?: readonly string[];
  readonly environment?: Record<string, string>;
  readonly volumes?: readonly (string | { readonly type: string; readonly source: string; readonly target: string; readonly read_only?: boolean; readonly bind?: { readonly create_host_path?: boolean } })[];
  readonly depends_on?: Record<string, { readonly condition: string }>;
}
const askOverride = services('deploy/demo/compose.ask.yaml') as Record<string, OverrideService>;

describe('the demo override that switches Ask on', () => {
  it('holds exactly the config, migrate and api services and nothing else', () => {
    expect(Object.keys(askOverride).sort()).toEqual(['api', 'config', 'migrate']);
  });

  it('has the config service combine the packs with the Ask option, over the same packs the base file combines', () => {
    const base = (demo['config'] as { command?: readonly string[] } | undefined)?.command ?? [];
    expect(askOverride['config']?.command).toEqual([...base.slice(0, base.indexOf('--out')), '--ask', ...base.slice(base.indexOf('--out'))]);
  });

  it('has migrate and api run with the enterprise profile, and migrate read the mapping the config service wrote, after it finished', () => {
    expect(askOverride['migrate']?.environment).toEqual({ NEBURYX_PROFILE: 'enterprise', NEBURYX_CONFIG: '/config/neburyx.yaml' });
    expect(askOverride['migrate']?.volumes).toEqual(['demo-config:/config:ro']);
    expect(askOverride['migrate']?.depends_on).toEqual({ config: { condition: 'service_completed_successfully' } });
    expect(askOverride['api']?.environment?.['NEBURYX_PROFILE']).toBe('enterprise');
  });

  it('has the api read the folder the config service wrote, and the key from a file mounted read-only by the long bind syntax that creates nothing on the host, whose path must be given', () => {
    expect(askOverride['api']?.environment).toMatchObject({ NEBURYX_ASK_MAPPING_FOLDER: '/config/ask', NEBURYX_ASK_API_KEY_FILE: '/run/ask/key' });
    const [mount, ...more] = askOverride['api']?.volumes ?? [];
    expect(more).toEqual([]);
    expect(mount).toMatchObject({ type: 'bind', target: '/run/ask/key', read_only: true, bind: { create_host_path: false } });
    expect(typeof mount === 'object' ? mount.source : '').toMatch(/^\$\{NEBURYX_DEMO_ASK_KEY_FILE:\?[^}]+\}$/);
  });

  it('passes no key by value and holds no secret', () => {
    const text = readFileSync(join(repository, 'deploy/demo/compose.ask.yaml'), 'utf8');
    expect(text).not.toMatch(/NEBURYX_ASK_API_KEY\b(?!_FILE)/);
  });
});
