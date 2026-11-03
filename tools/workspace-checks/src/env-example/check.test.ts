import { describe, expect, it } from 'vitest';
import { makeRoot } from '../domain-words/fixtures.js';
import { repoRoot } from '../workspace.js';
import { checkEnvExample, formatEnvViolations, readsOf } from './check.js';

const EXAMPLE = ['# One.', 'ALPHA=', '# Two.', 'BETA=value', '# Three.', '# GAMMA=1'].join('\n');
const SOURCE = "export const read = (env: Record<string, string | undefined>) => [env['ALPHA'], env.BETA, env['GAMMA']];\n";

function root(example: string, files: Record<string, string>): string {
  return makeRoot({ '.env.example': `${example}\n`, ...files });
}

describe('the API variables against .env.example in this repository', () => {
  it('agree, and are the nine the API reads', () => {
    expect(checkEnvExample(repoRoot)).toEqual([]);
    const names = [...new Set(readsOf(repoRoot).flatMap((entry) => (entry.name === undefined ? [] : [entry.name])))].sort();
    expect(names).toEqual(['DATABASE_APP_ROLE', 'DATABASE_MIGRATION_URL', 'DATABASE_URL', 'NEBURYX_CONFIG', 'NEBURYX_CONTAINER', 'NEBURYX_CURSOR_KEY', 'NEBURYX_HOST', 'NEBURYX_PORT', 'NEBURYX_WEB_ROOT']);
  });

  it('keep the secrets without a value', () => {
    expect(checkEnvExample(repoRoot).filter((violation) => violation.kind === 'secret-has-value')).toEqual([]);
  });
});

describe('the check', () => {
  it('passes when the listed variables are the read ones, each described, commented-out ones included', () => {
    expect(checkEnvExample(root(EXAMPLE, { 'services/api/src/a.ts': SOURCE }))).toEqual([]);
  });

  it('fails for a variable the API reads that .env.example does not list, naming the variable and the file', () => {
    const violations = checkEnvExample(root(EXAMPLE, { 'services/api/src/a.ts': SOURCE, 'services/api/src/b.ts': "export const x = process.env['DELTA'];\n" }));
    expect(violations).toEqual([{ kind: 'unlisted', name: 'DELTA', file: 'services/api/src/b.ts', line: 1 }]);
    expect(formatEnvViolations(violations)).toContain('DELTA is read by the API and is not in .env.example (services/api/src/b.ts:1)');
  });

  it('fails for a listed variable that no source reads, naming it', () => {
    const violations = checkEnvExample(root(`${EXAMPLE}\n# Four.\nEPSILON=`, { 'services/api/src/a.ts': SOURCE }));
    expect(violations.map((violation) => `${violation.kind} ${violation.name}`)).toEqual(['unused EPSILON']);
  });

  it('fails for a listed variable without a description line directly above it', () => {
    const violations = checkEnvExample(root('ALPHA=\nBETA=\n# Three.\nGAMMA=', { 'services/api/src/a.ts': SOURCE }));
    expect(violations.map((violation) => `${violation.kind} ${violation.name}`)).toEqual(['undescribed ALPHA', 'undescribed BETA']);
  });

  it('fails for a secret that has a value', () => {
    const violations = checkEnvExample(root('# A.\nDATABASE_URL=postgres://x\n', { 'services/api/src/a.ts': "export const x = process.env.DATABASE_URL;\n" }));
    expect(violations).toEqual([{ kind: 'secret-has-value', name: 'DATABASE_URL', file: '.env.example', line: 2 }]);
  });
});

describe('the forms of a read', () => {
  const forms = [
    "export const a = env['A_ONE'];",
    'export const b = env.B_TWO;',
    'export const c = process.env.C_THREE;',
    "export const d = process.env['D_FOUR'];",
    "const keys = { host: 'E_FIVE' } as const;\nexport const e = env[keys.host];",
    "const F_KEY = 'F_SIX';\nexport const f = env[F_KEY];",
    'export const g = deps.env.G_SEVEN;',
  ];

  it('are all found', () => {
    const files = Object.fromEntries(forms.map((text, index) => [`services/api/src/form${index}.ts`, `${text}\n`]));
    const names = readsOf(makeRoot(files)).map((entry) => entry.name);
    expect(names.sort()).toEqual(['A_ONE', 'B_TWO', 'C_THREE', 'D_FOUR', 'E_FIVE', 'F_SIX', 'G_SEVEN']);
  });

  it('are not found in tests, test helpers or other folders', () => {
    const files = {
      'services/api/src/a.test.ts': "export const x = process.env['IN_A_TEST'];\n",
      'services/api/src/testing/helper.ts': "export const x = process.env['IN_A_HELPER'];\n",
      'services/api/src/image/helper.ts': "export const x = process.env['IN_AN_IMAGE_HELPER'];\n",
      'apps/web/src/a.ts': "export const x = process.env['IN_THE_WEB_APP'];\n",
    };
    expect(readsOf(makeRoot(files))).toEqual([]);
  });

  it('fail the check when the key cannot be resolved, naming the file', () => {
    const files = { 'services/api/src/a.ts': 'export const x = (name: string) => process.env[name];\n' };
    const violations = checkEnvExample(root('# One.\nALPHA=', { ...files, 'services/api/src/b.ts': "export const y = process.env['ALPHA'];\n" }));
    expect(violations).toEqual([{ kind: 'unresolved', file: 'services/api/src/a.ts', line: 1 }]);
    expect(formatEnvViolations(violations)).toContain('services/api/src/a.ts:1');
  });
});

describe('a key that looks like a constant but is not trusted', () => {
  const listed = (files: Record<string, string>) => checkEnvExample(root('# One.\nLISTED=', { 'services/api/src/a.ts': "export const x = process.env['LISTED'];\n", ...files }));

  it('is unresolved when the constant is shadowed by a parameter of the same name', () => {
    const violations = listed({ 'services/api/src/b.ts': "const KEY = 'LISTED';\nexport const f = (KEY: string) => process.env[KEY];\nexport const g = KEY;\n" });
    expect(violations).toEqual([{ kind: 'unresolved', file: 'services/api/src/b.ts', line: 2 }]);
  });

  it('is unresolved when it is a let that can change, or is declared twice', () => {
    const mutable = listed({ 'services/api/src/b.ts': "let KEY = 'LISTED';\nKEY = process.argv[2] ?? KEY;\nexport const f = process.env[KEY];\n" });
    expect(mutable).toEqual([{ kind: 'unresolved', file: 'services/api/src/b.ts', line: 3 }]);
    const twice = listed({ 'services/api/src/b.ts': "const KEY = 'LISTED';\nexport function h() { const KEY = 'OTHER'; return process.env[KEY]; }\n" });
    expect(twice).toEqual([{ kind: 'unresolved', file: 'services/api/src/b.ts', line: 2 }]);
  });
});

describe('the credential resolver', () => {
  const resolver = 'export const read = (source: { auth: { usernameEnv: string } }, env: Record<string, string | undefined>) => env[source.auth.usernameEnv];\n';

  it('is the one file allowed to read the names a mapping gives, and a second such read elsewhere fails', () => {
    const allowed = checkEnvExample(root('# One.\nALPHA=', { 'services/api/src/sources/credentials.ts': resolver, 'services/api/src/a.ts': "export const x = process.env['ALPHA'];\n" }));
    expect(allowed).toEqual([]);
    const second = checkEnvExample(root('# One.\nALPHA=', { 'services/api/src/sources/credentials.ts': resolver, 'services/api/src/elsewhere.ts': resolver, 'services/api/src/a.ts': "export const x = process.env['ALPHA'];\n" }));
    expect(second).toEqual([{ kind: 'unresolved', file: 'services/api/src/elsewhere.ts', line: 1 }]);
  });

  it('allows only the two reads of the mapping\'s login names, not another computed read in the same file', () => {
    const another = `${resolver}export const other = (name: string, env: Record<string, string | undefined>) => env[name];\n`;
    const violations = checkEnvExample(root('# One.\nALPHA=', { 'services/api/src/sources/credentials.ts': another, 'services/api/src/a.ts': "export const x = process.env['ALPHA'];\n" }));
    expect(violations).toEqual([{ kind: 'unresolved', file: 'services/api/src/sources/credentials.ts', line: 2 }]);
  });
});
