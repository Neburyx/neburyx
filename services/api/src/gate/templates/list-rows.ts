import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { Row } from '../types.js';

const rowSchema = z.object({ i: z.number().int().nonnegative(), dup: z.boolean() });

/**
 * The rows of a read of a list: each names its position in the list the read was given and whether another record has the ID. The statement answers positions in increasing order and none twice, each inside the list,
 * so a row that does not is a defect that is refused, never an element that quietly reads as missing.
 */
export function positionedRows(rows: readonly Row[], count: unknown): readonly { readonly row: Row; readonly index: number; readonly duplicate: boolean }[] {
  const length = Array.isArray(count) ? count.length : 0;
  let previous = -1;
  return rows.map((row) => {
    const { i, dup } = rowSchema.parse(row);
    if (i <= previous || i >= length) throw new AppError('INTERNAL_ERROR');
    previous = i;
    return { row, index: i, duplicate: dup };
  });
}
