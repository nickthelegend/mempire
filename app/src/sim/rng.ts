// xorshift32 — deterministic match RNG. Seed comes from both players' commit-reveal
// so neither side can precompute outcomes.
export class XorShift32 {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let x = this.s;
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    this.s = x >>> 0;
    return this.s;
  }

  // [0, n)
  nextInt(n: number): number {
    return this.next() % n;
  }

  state(): number {
    return this.s;
  }
}
