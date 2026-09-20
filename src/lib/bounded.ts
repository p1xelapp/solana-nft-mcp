/**
 * A Map with a ceiling and an expiry, for every process-wide cache that is
 * keyed by something a caller chooses.
 *
 * The plain Maps this replaces expired their entries on read and never
 * removed them: a session that asked about 2,100 names nobody had heard of
 * kept 2,100 misses, and asking one more a day later made it 2,101.
 * Expiry without removal bounds reuse, not memory.
 *
 * Eviction is by insertion order, oldest first, which is what a cache of
 * recent lookups wants; a hit is re-inserted so it counts as recent.
 */
export class BoundedMap<V> {
  private readonly entries = new Map<string, { at: number; value: V }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** When the live entry was stored, for callers that report cache age. */
  storedAt(key: string): number | null {
    const hit = this.entries.get(key);
    return hit && Date.now() - hit.at <= this.ttlMs ? hit.at : null;
  }

  set(key: string, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { at: Date.now(), value });
    if (this.entries.size > this.max) this.sweep();
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drop every expired entry. Called when the ceiling is reached, before anything live is evicted. */
  sweep(): void {
    const now = Date.now();
    for (const [key, hit] of this.entries) if (now - hit.at > this.ttlMs) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
