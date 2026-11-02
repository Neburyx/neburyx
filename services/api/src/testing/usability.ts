import type { SourceUsability } from '../source-test/usability.js';

/** A record in which every source is usable: for tests that are not about the refusal of a data read. */
export const ALWAYS_USABLE: SourceUsability = { isUsable: () => true };
