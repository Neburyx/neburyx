import { describe, expect, it } from 'vitest';
import { parseCommand, USAGE } from './commands.js';

describe('parseCommand', () => {
  it.each([
    [[], 'api'],
    [['api'], 'api'],
    [['migrate'], 'migrate'],
    [['migrate', 'extra'], 'migrate'],
  ] as const)('reads %j as %s', (args, expected) => {
    expect(parseCommand(args)).toBe(expected);
  });

  it.each([['bogus'], ['API'], [''], ['--help']])('refuses %j', (word) => {
    expect(parseCommand([word])).toBeUndefined();
  });

  it('prints the usage line the image documents', () => {
    expect(USAGE).toBe('usage: neburyx api | migrate\n');
  });
});
