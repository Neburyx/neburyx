import { describe, expect, it } from 'vitest';
import { expandNeighborsTemplate } from './expand-neighbors.js';

describe('the description of the expansion template, which the template list shows', () => {
  it('says that it takes a window of days or of dates and what the window follows', () => {
    expect(expandNeighborsTemplate.description).toContain('a window of days or of dates');
    expect(expandNeighborsTemplate.description).toContain("follows each relationship type's own observed time");
    expect(expandNeighborsTemplate.description).toContain('a relationship type with no observed time is not filtered');
  });

  it('tells which template a question of a chain belongs to instead', () => {
    expect(expandNeighborsTemplate.description).toContain('use linked-entities');
  });
});
