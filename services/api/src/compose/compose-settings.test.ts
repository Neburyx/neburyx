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
const MIGRATE_SETTINGS = ['NEBURYX_PROFILE', 'NEBURYX_DATABASE_CONNECT_TIMEOUT_MS'];
const MAPPING_MOUNT = '${NEBURYX_CONFIG_DIR:-./config}:/etc/neburyx:ro';

describe('the settings the Community compose file passes', () => {
  it('gives the api service the profile, the cache settings and the two database limits, each with an empty default', () => {
    for (const name of API_SETTINGS) expect(community['api']?.environment?.[name], name).toBe(`\${${name}:-}`);
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
    for (const name of API_SETTINGS) expect(text).not.toMatch(new RegExp(`\\$\\{${name}:-[^}]`));
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
});
