const PASSED_LINE = /^\s*Tests\s+(?:\d+ failed \| )?(\d+) passed/m;

/** The number of tests a vitest run reports as passed, or undefined when its summary is missing. */
export function testsPassed(output: string): number | undefined {
  const match = PASSED_LINE.exec(output);
  const count = match?.[1];
  return count === undefined ? undefined : Number(count);
}
