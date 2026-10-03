import { invalidInput } from './errors.js';

/** Keyset cursor over (createdAt DESC, id DESC). */
export interface CursorPosition {
  createdAt: number;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    if (cursor.length > 512) throw new Error('too long');
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      parsed[1].length <= 256
    ) {
      return { createdAt: parsed[0] as number, id: parsed[1] };
    }
  } catch {
    // fall through to the validation error below
  }
  throw invalidInput('Invalid pagination cursor');
}

/** True when the item sorts after the cursor position in (createdAt DESC, id DESC) order. */
export function isAfterCursor(item: CursorPosition, cursor: CursorPosition): boolean {
  return (
    item.createdAt < cursor.createdAt ||
    (item.createdAt === cursor.createdAt && item.id < cursor.id)
  );
}

export function compareDesc(a: CursorPosition, b: CursorPosition): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
