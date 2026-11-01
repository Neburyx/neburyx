export function exhaustive(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}
