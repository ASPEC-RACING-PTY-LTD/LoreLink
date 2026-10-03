export interface CacheStatsSnapshot {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  evictions: number;
  hitRatio: number;
  namespaces: Record<
    string,
    Omit<CacheStatsSnapshot, 'namespaces' | 'hitRatio'> & { hitRatio: number }
  >;
}

export class StatsCounter {
  hits = 0;
  misses = 0;
  sets = 0;
  deletes = 0;
  errors = 0;
  evictions = 0;
  private readonly byNs = new Map<string, StatsCounter>();

  child(namespace: string): StatsCounter {
    let child = this.byNs.get(namespace);
    if (!child) {
      child = new StatsCounter();
      this.byNs.set(namespace, child);
    }
    return child;
  }

  snapshot(): CacheStatsSnapshot {
    const total = this.hits + this.misses;
    const namespaces: CacheStatsSnapshot['namespaces'] = {};
    for (const [name, counter] of this.byNs) {
      const nTotal = counter.hits + counter.misses;
      namespaces[name] = {
        hits: counter.hits,
        misses: counter.misses,
        sets: counter.sets,
        deletes: counter.deletes,
        errors: counter.errors,
        evictions: counter.evictions,
        hitRatio: nTotal === 0 ? 0 : counter.hits / nTotal,
      };
    }
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      errors: this.errors,
      evictions: this.evictions,
      hitRatio: total === 0 ? 0 : this.hits / total,
      namespaces,
    };
  }

  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.errors = 0;
    this.evictions = 0;
    this.byNs.clear();
  }
}
