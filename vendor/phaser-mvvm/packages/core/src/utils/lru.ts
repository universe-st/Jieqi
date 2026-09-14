/**
 * A tiny LRU cache.
 *
 * `Map` iteration order doubles as recency order, so a hit is a delete + re-insert and an eviction is
 * "drop the first key". Small and dependency-free on purpose: the layout and text caches in the higher
 * packages use it, and a `Map`-based cache beats a hand-written linked list at these sizes.
 */

export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly maxEntries = 512) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
