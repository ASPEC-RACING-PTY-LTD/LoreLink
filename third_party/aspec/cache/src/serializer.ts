import { CacheError, CacheErrorCode } from './errors.js';

export interface CacheSerializer {
  encode(value: unknown): string;
  decode<T = unknown>(raw: string): T;
}

/** JSON serializer (default). Dates become ISO strings on encode. */
export const jsonSerializer: CacheSerializer = {
  encode(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      throw new CacheError(CacheErrorCode.SERIALIZE, 'Failed to serialize cache value', {
        cause: error,
      });
    }
  },
  decode<T>(raw: string) {
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new CacheError(CacheErrorCode.SERIALIZE, 'Failed to deserialize cache value', {
        cause: error,
      });
    }
  },
};
