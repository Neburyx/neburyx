export interface Rng {
  next(): number;
  between(min: number, max: number): number;
  bigBetween(min: bigint, max: bigint): bigint;
}

function hashSeed(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** A small, fast generator (sfc32) seeded from the seed and a stream name, so each stream is independent of the others. */
export function createRng(seed: number, stream: string): Rng {
  let [a, b, c, d] = hashSeed(`${seed}:${stream}`);
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let warmUp = 0; warmUp < 16; warmUp++) next();
  return {
    next,
    between: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bigBetween: (min, max) => {
      const range = max - min + 1n;
      let value = 0n;
      for (let part = 0; part < 4; part++) value = (value << 32n) | BigInt(Math.floor(next() * 4294967296));
      return min + (value % range);
    },
  };
}
