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
    expect(USAGE).toBe('usage: neburyx api | migrate | test-source --name <source>\n');
    expect(TEST_SOURCE_USAGE).toBe('usage: neburyx test-source --name <source>\n');
  });
});

describe('parseTestSourceArgs', () => {
  it('reads the source name', () => {
    expect(parseTestSourceArgs(['--name', 'alpha'])).toBe('alpha');
  });

  it.each([
    [[]],
    [['--name']],
    [['--name', '']],
    [['--name', '--name']],
    [['--name', 'alpha', '--name', 'beta']],
    [['--name', 'alpha', 'extra']],
    [['--write-probe']],
    [['--write-probe', '--name', 'alpha']],
    [['--name', 'alpha', '--write-probe']],
    [['alpha']],
    [['--other', 'alpha']],
  ])('refuses %j', (args) => {
    expect(parseTestSourceArgs(args)).toBeUndefined();
  });
});
