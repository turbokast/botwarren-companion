/** Small in-memory limiters. Nothing here is persisted or logged. Licence: Apache-2.0. */

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perSec: number;
  constructor(capacity: number, perSec: number, now: number) { this.capacity = capacity; this.perSec = perSec; this.tokens = capacity; this.last = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
  retryMs(): number { return Math.ceil(((1 - this.tokens) / this.perSec) * 1000); }
}

/** keyed buckets with a hard cap on the number of keys (oldest dropped) so memory cannot grow without bound */
export class KeyedLimiter {
  private readonly m = new Map<string, TokenBucket>();
  private readonly capacity: number;
  private readonly perSec: number;
  private readonly maxKeys: number;
  constructor(capacity: number, perSec: number, maxKeys = 50_000) { this.capacity = capacity; this.perSec = perSec; this.maxKeys = maxKeys; }
  take(key: string, now: number): boolean {
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size >= this.maxKeys) this.m.delete(this.m.keys().next().value as string);
      b = new TokenBucket(this.capacity, this.perSec, now);
      this.m.set(key, b);
    }
    return b.take(now);
  }
  retryMs(key: string): number { return this.m.get(key)?.retryMs() ?? 0; }
  get size(): number { return this.m.size; }
}
