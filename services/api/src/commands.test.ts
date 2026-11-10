import { describe, expect, it } from 'vitest';
import { parseCommand, parseRebindArgs, parseTestSourceArgs, SOURCE_REBIND_USAGE, TEST_SOURCE_USAGE, USAGE } from './commands.js';

describe('parseCommand', () => {
  it.each([
    [[], 'api'],
    [['api'], 'api'],
    [['migrate'], 'migrate'],
    [['migrate', 'extra'], 'migrate'],
    [['test-source', '--name', 'alpha'], 'test-source'],
    [['source', 'rebind', 'alpha'], 'source'],
  ] as const)('reads %j as %s', (args, expected) => {
    expect(parseCommand(args)).toBe(expected);
  });

  it.each([['bogus'], ['API'], [''], ['--help']])('refuses %j', (word) => {
    expect(parseCommand([word])).toBeUndefined();
  });

  it('prints the usage line the image documents', () => {
    expect(USAGE).toBe('usage: neburyx api | migrate | test-source --name <source> [--write-probe] | source rebind <source> [--confirm <source>]\n');
    expect(SOURCE_REBIND_USAGE).toBe('usage: neburyx source rebind <source> [--confirm <source>]\n');
    expect(TEST_SOURCE_USAGE).toBe('usage: neburyx test-source --name <source> [--write-probe]\n');
  });
});

describe('parseTestSourceArgs', () => {
  it('reads the source name', () => {
    expect(parseTestSourceArgs(['--name', 'alpha'])).toEqual({ name: 'alpha', writeProbe: false });
  });

  it.each([[['--name', 'alpha', '--write-probe']], [['--write-probe', '--name', 'alpha']]])('reads the write probe flag once, before or after the name: %j', (args) => {
    expect(parseTestSourceArgs(args)).toEqual({ name: 'alpha', writeProbe: true });
  });

  it.each([
    [[]],
    [['--name']],
    [['--name', '']],
    [['--name', '--name']],
    [['--name', 'alpha', '--name', 'beta']],
    [['--name', 'alpha', 'extra']],
    [['--write-probe']],
    [['--write-probe', '--write-probe', '--name', 'alpha']],
    [['--name', 'alpha', '--write-probe', '--write-probe']],
    [['--write-probe', '--name', 'alpha', '--write-probe']],
    [['--write-probe', 'yes', '--name', 'alpha']],
    [['--name', 'alpha', '--write-probe', 'yes']],
    [['--name', '--write-probe']],
    [['--write-probe', '--name', '--write-probe']],
    [['--write-probe', '--name']],
    [['--write-probe=true', '--name', 'alpha']],
    [['--name', 'alpha', '--probe']],
    [['alpha']],
    [['--other', 'alpha']],
  ])('refuses %j', (args) => {
    expect(parseTestSourceArgs(args)).toBeUndefined();
  });
});

describe('parseRebindArgs', () => {
  it('reads the source ID, with the confirmation before or after it', () => {
    expect(parseRebindArgs(['rebind', 'alpha'])).toEqual({ id: 'alpha' });
    expect(parseRebindArgs(['rebind', 'alpha', '--confirm', 'alpha'])).toEqual({ id: 'alpha', confirm: 'alpha' });
    expect(parseRebindArgs(['rebind', '--confirm', 'beta', 'alpha'])).toEqual({ id: 'alpha', confirm: 'beta' });
  });

  it.each([[[]], [['rebind']], [['rebind', '']], [['rebind', '--confirm']], [['rebind', 'alpha', '--confirm']], [['rebind', 'alpha', '--confirm', '--x']], [['rebind', 'alpha', 'beta']], [['rebind', 'alpha', '--confirm', 'a', 'b']], [['migrate', 'alpha']], [['rebind', '--force', 'alpha']]])('refuses %j', (args) => {
    expect(parseRebindArgs(args)).toBeUndefined();
  });
});
