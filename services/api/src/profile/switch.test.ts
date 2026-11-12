import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import { parseMapping } from '../mapping/load.js';
import { MappingError } from '../mapping/diagnostics.js';
import { baseSource } from '../testing/mapping.js';
import { decidePreviewSwitch, parseProfile, previewInputsOf } from './switch.js';

const mappingWith = (ai: unknown) => parseMapping(stringify({ sources: [baseSource()], ...(ai === undefined ? {} : { ai }) }), 'neburyx.yaml');

describe('the preview switch decision', () => {
  const PROFILES: readonly (readonly [string, string | undefined])[] = [
    ['unset', undefined],
    ['empty', ''],
    ['community', 'community'],
    ['enterprise', 'enterprise'],
  ];
  const PREVIEWS: readonly (readonly [string, unknown])[] = [
    ['absent', undefined],
    ['false', { preview: false }],
    ['true', { preview: true }],
  ];

  it.each(PROFILES.flatMap(([profileName, profile]) => PREVIEWS.map(([previewName, ai]) => ({ profileName, profile, previewName, ai }))))(
    'profile $profileName with ai.preview $previewName',
    ({ profile, profileName, ai, previewName }) => {
      const decision = decidePreviewSwitch(previewInputsOf(profile === undefined ? {} : { NEBURYX_PROFILE: profile }, mappingWith(ai)));
      const enterprise = profileName === 'enterprise';
      const preview = previewName === 'true';
      if (enterprise && preview) expect(decision).toEqual({ state: 'on' });
      else if (!enterprise && !preview) expect(decision).toEqual({ state: 'off' });
      else if (enterprise) {
        expect(decision.state).toBe('refused');
        expect(decision).toMatchObject({ message: expect.stringContaining('NEBURYX_PROFILE=enterprise is set but ai.preview: true is not set') });
      } else {
        expect(decision.state).toBe('refused');
        expect(decision).toMatchObject({ message: expect.stringContaining('ai.preview: true is set in the mapping file but NEBURYX_PROFILE=enterprise is not set') });
      }
    },
  );

  it.each(['Enterprise', 'enterprise ', 'preview', 'true', '1'])('refuses the profile value %j naming the key and not the value', (value) => {
    expect(() => parseProfile({ NEBURYX_PROFILE: value })).toThrow(new ConfigError(['NEBURYX_PROFILE']));
    expect(new ConfigError(['NEBURYX_PROFILE']).message).toBe('invalid configuration: NEBURYX_PROFILE');
  });
});

describe('the ai section of the mapping file', () => {
  it('reads preview as a boolean and leaves the section out of a model that has none', () => {
    expect(mappingWith({ preview: true }).ai).toEqual({ preview: true });
    expect(mappingWith({ preview: false }).ai).toEqual({ preview: false });
    expect(mappingWith({}).ai).toEqual({ preview: false });
    expect(mappingWith(undefined).ai).toBeUndefined();
  });

  it.each([
    ['a text value for preview', { preview: 'yes' }],
    ['a key other than preview', { model: 'x' }],
    ['a section that is not a map', 'on'],
  ])('refuses %s', (_name, ai) => {
    expect(() => mappingWith(ai)).toThrow(MappingError);
  });
});

describe('where the switch is read', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const profileFolder = join(root, 'profile');

  function productionFiles(folder: string): readonly string[] {
    return readdirSync(folder).flatMap((name) => {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) return name === 'testing' ? [] : productionFiles(path);
      return path.endsWith('.ts') && !path.includes('.test.') ? [path] : [];
    });
  }

  it('is named only under profile/, outside test files', () => {
    const offenders = productionFiles(root)
      .filter((file) => !file.startsWith(profileFolder))
      .filter((file) => /NEBURYX_PROFILE|\bmapping\.ai\??\.preview/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('is decided by both callers through decidePreviewSwitch(previewInputsOf(env, mapping))', () => {
    const start = readFileSync(join(root, 'start.ts'), 'utf8');
    expect(start).toContain('decidePreviewSwitch(previewInputsOf(env, mapping))');
    expect(readFileSync(join(root, 'migrate', 'command.ts'), 'utf8')).toContain('decidePreviewSwitch(previewInputsOf(env, mapping))');
  });
});
