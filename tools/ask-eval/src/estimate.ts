/** The product's bytes to a token, the figure an estimate of a request's input uses. */
const BYTES_PER_TOKEN = 1.8;

export const tokensOf = (bytes: number): number => Math.ceil(bytes / BYTES_PER_TOKEN);
