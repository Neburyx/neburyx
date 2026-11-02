import { describe, expect, it } from 'vitest';
import { parseCommand, parseTestSourceArgs, TEST_SOURCE_USAGE, USAGE } from './commands.js';

describe('parseCommand', () => {
  it.each([
    [[], 'api'],
    [['api'], 'api'],
    [['migrate'], 'migrate'],
    [['migrate', 'extra'], 'migrate'],
    [['test-source', '--name', 'alpha'], 'test-source'],
  ] as const)('reads %j as %s', (args, expected) => {
    expect(parseCommand(args)).toBe(expected);
  });

  it.each([['bogus'], ['API'], [''], ['--help']])('refuses %j', (word) => {
    expect(parseCommand([word])).toBeUndefined();
  });

  it('prints the usage line the image documents', () => {
    expect(USAGE).toBe('usage: neburyx api | migrate | test-source --name <source> [--write-probe]\n');
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
