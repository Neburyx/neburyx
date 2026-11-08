import { countSchema } from '@neburyx/contracts';

/** Fails when a count that reached the page lacks its quality: it must be one the contract accepts, an `unknown` count must hold no number, and `observedAt` may appear only on an `estimated` count. */
export function checkCountLabel(count: unknown, where: string): void {
  const parsed = countSchema.safeParse(count);
  if (!parsed.success) throw new Error(`${where}: a count the contract refuses (${parsed.error.issues.map((issue) => issue.message).join('; ')}): ${JSON.stringify(count)}`);
}
