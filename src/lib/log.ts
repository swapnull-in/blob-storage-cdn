/** Timestamped logging so you can watch bytes move (and not move through your servers). */
export function log(...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...args);
}

/** A tiny deterministic 32-bit string hash (FNV-1a + finalizer) shared across phases. */
export function hash32(str: string, seed = 0): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32) so every run prints identical numbers. */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
