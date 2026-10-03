/** Matches event types with optional trailing wildcard segments (`invoice.*`, `*`). */
export function eventMatches(filter: string, eventType: string): boolean {
  if (filter === '*' || filter === eventType) return true;
  if (filter.endsWith('.*')) {
    const prefix = filter.slice(0, -1); // keep trailing dot
    return eventType.startsWith(prefix) || eventType === filter.slice(0, -2);
  }
  return false;
}

export function anyEventMatches(filters: readonly string[], eventType: string): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => eventMatches(f, eventType));
}

/**
 * Declarative payload filter: each entry is a dotted path that must equal the given value.
 * Supports equality only. Missing paths fail the filter.
 */
export function payloadMatches(
  filter: Readonly<Record<string, unknown>> | undefined,
  payload: unknown,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (payload === null || typeof payload !== 'object') return false;
  for (const [path, expected] of Object.entries(filter)) {
    const actual = getPath(payload, path);
    if (!Object.is(actual, expected) && JSON.stringify(actual) !== JSON.stringify(expected)) {
      return false;
    }
  }
  return true;
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
