export interface StoreEntry {
  value: unknown;
  /** Absolute expiry epoch ms; undefined means no expiry. */
  expiresAt?: number;
  tags?: readonly string[];
}

export interface CacheStore {
  readonly name: string;
  get(key: string): Promise<StoreEntry | undefined>;
  set(key: string, entry: StoreEntry): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteMany(keys: readonly string[]): Promise<number>;
  /** Removes every key that carries the tag. */
  invalidateTag(tag: string): Promise<number>;
  /** Bumps a generation so every namespaced key is effectively gone. */
  bumpGeneration(namespace: string): Promise<number>;
  getGeneration(namespace: string): Promise<number>;
  /** Remaining TTL in ms, or undefined when missing / no expiry. */
  ttl(key: string): Promise<number | undefined>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
