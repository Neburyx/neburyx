import { describe, expect, it } from 'vitest';
import { DefinitionError, parseDefinition } from './definition.js';
import { generate } from './generate.js';
import { miniDefinition, miniDefinitionText, miniMapping } from './testing/fixture.js';
import { linesOf, tagText } from './testing/records.js';

const dated = parseDefinition(`reference_date: "2026-06-30"\n${miniDefinitionText}`, miniMapping);
const allLines = (generated: ReturnType<typeof generate>): string[] => generated.files.flatMap((file) => file.lines);
const times = (generated: ReturnType<typeof generate>): string[] => linesOf(generated, 'HAS').flatMap((edge) => (edge.p.seenAt === undefined ? [] : [tagText(edge.p.seenAt, '$datetime')]));

describe('the build date', () => {
  it('is refused when the definition has no reference date, naming the key', () => {
    expect(() => generate(miniMapping, miniDefinition, 11, '2026-11-14')).toThrow(DefinitionError);
    expect(() => generate(miniMapping, miniDefinition, 11, '2026-11-14')).toThrow(/reference_date/);
  });

  it('is refused when it is not a calendar day, and so is a reference date that is not', () => {
    expect(() => generate(miniMapping, dated, 11, '2026-02-31')).toThrow(/build_date/);
    expect(() => generate(miniMapping, dated, 11, '14-11-2026')).toThrow(/build_date/);
    expect(() => parseDefinition(`reference_date: "2026-13-01"\n${miniDefinitionText}`, miniMapping)).toThrow(/reference_date/);
  });

  it('is refused, naming the property, when a date would leave the years 0001 to 9999', () => {
    expect(() => generate(miniMapping, dated, 11, '0001-01-01')).toThrow(/properties\.madeOn/);
  });

  it('leaves the output as it was when no build date is given, whether or not the definition has a reference date', () => {
    expect(allLines(generate(miniMapping, dated, 11))).toEqual(allLines(generate(miniMapping, miniDefinition, 11)));
  });

  it('gives byte-identical data for the same seed and build date, and the same data at the reference date as with none', () => {
    expect(allLines(generate(miniMapping, dated, 11, '2026-11-14'))).toEqual(allLines(generate(miniMapping, dated, 11, '2026-11-14')));
    expect(allLines(generate(miniMapping, dated, 11, '2026-06-30'))).toEqual(allLines(generate(miniMapping, miniDefinition, 11)));
    expect(generate(miniMapping, dated, 11, '2026-06-30').buildDate).toBe('2026-06-30');
  });

  it('moves every date and time by exactly the days between two build dates, and nothing else', () => {
    const early = generate(miniMapping, dated, 11, '2026-06-30');
    const late = generate(miniMapping, dated, 11, '2026-09-28');
    const days = 90;
    const was = times(early);
    const now = times(late);
    expect(was.length).toBeGreaterThan(0);
    expect(now).toHaveLength(was.length);
    for (const [index, value] of was.entries()) expect(Date.parse(now[index] ?? '') - Date.parse(value)).toBe(days * 86_400_000);
    const strip = (generated: ReturnType<typeof generate>) => allLines(generated).map((line) => line.replace(/"\$datetime":"[^"]+"/g, '"$datetime":"-"').replace(/"\$date":"[^"]+"/g, '"$date":"-"'));
    expect(strip(late)).toEqual(strip(early));
  });

  it('ends the dates at the build date: no time is later than the end of the build day', () => {
    const shown = times(generate(miniMapping, dated, 11, '2027-03-01')).sort();
    expect(shown.at(-1) ?? '').toMatch(/^2027-0(2-2|3-01)/);
    expect((shown.at(-1) ?? '') <= '2027-03-01T23:59:59Z').toBe(true);
  });
});
