/** Bytes inspected by sniffContentType. Uploads buffer at most this much before validation. */
export const SNIFF_BYTES = 8192;

export const OCTET_STREAM = 'application/octet-stream';

export interface SniffResult {
  /** Detected MIME type, or undefined when the content matches no known signature. */
  type?: string;
  /** True for types that can carry active content when rendered by a browser (SVG, HTML). */
  scriptable: boolean;
}

function startsWith(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(buf: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end && i < buf.length; i++) out += String.fromCharCode(buf[i] ?? 0);
  return out;
}

const MP4_AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

function sniffBinary(buf: Uint8Array): string | undefined {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const head6 = ascii(buf, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (ascii(buf, 0, 4) === 'RIFF' && buf.length >= 12) {
    const form = ascii(buf, 8, 12);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
    if (form === 'AVI ') return 'video/x-msvideo';
  }
  if (startsWith(buf, [0x42, 0x4d]) && buf.length >= 14 && buf[6] === 0 && buf[7] === 0) {
    return 'image/bmp';
  }
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  if (ascii(buf, 0, 5) === '%PDF-') return 'application/pdf';
  if (
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buf, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'application/zip';
  }
  if (startsWith(buf, [0x1f, 0x8b, 0x08])) return 'application/gzip';
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (ascii(buf, 4, 8) === 'ftyp' && buf.length >= 12) {
    const brand = ascii(buf, 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (MP4_AUDIO_BRANDS.has(brand)) return 'audio/mp4';
    if (brand.startsWith('heic') || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4';
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(buf, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(buf, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(buf, 0, 3) === 'ID3') return 'audio/mpeg';
  // MPEG audio frame sync: 11 set bits, a valid version, layer III and a valid bitrate.
  if (buf.length >= 3 && buf[0] === 0xff) {
    const b1 = buf[1] ?? 0;
    const b2 = buf[2] ?? 0;
    const syncOk = (b1 & 0xe0) === 0xe0;
    const version = (b1 >> 3) & 0x03;
    const layer = (b1 >> 1) & 0x03;
    const bitrate = (b2 >> 4) & 0x0f;
    if (syncOk && version !== 1 && layer === 1 && bitrate !== 0 && bitrate !== 0x0f) {
      return 'audio/mpeg';
    }
  }
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length >= 6 && buf[4] !== 0) {
    return 'image/vnd.microsoft.icon';
  }
  return undefined;
}

/**
 * Checks whether buf is UTF-8 text without NUL bytes and with few control characters.
 * When truncated is true an incomplete multi-byte sequence at the end is tolerated.
 */
export function looksLikeText(buf: Uint8Array, truncated: boolean): boolean {
  let control = 0;
  let i = 0;
  // Skip a UTF-8 byte order mark.
  if (startsWith(buf, [0xef, 0xbb, 0xbf])) i = 3;
  while (i < buf.length) {
    const b = buf[i] ?? 0;
    if (b === 0) return false;
    if (b < 0x80) {
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) {
        control++;
      } else if (b === 0x7f) {
        control++;
      }
      i++;
      continue;
    }
    let need: number;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return false;
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k];
      // A sequence cut off by the sniff window is fine; a cut at the real end is not.
      if (c === undefined) return truncated && control * 100 <= Math.max(buf.length, 1);
      if ((c & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  // Allow at most 1% control characters.
  return control * 100 <= Math.max(buf.length, 1);
}

function stripLeadingTextNoise(text: string): string {
  let s = text.replace(/^\uFEFF/, '');
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith('<?xml')) {
      const end = s.indexOf('?>');
      s = end === -1 ? '' : s.slice(end + 2);
    } else if (s.startsWith('<!--')) {
      const end = s.indexOf('-->');
      s = end === -1 ? '' : s.slice(end + 3);
    } else if (/^<!doctype\s+svg/i.test(s)) {
      const end = s.indexOf('>');
      s = end === -1 ? '' : s.slice(end + 1);
    }
    if (s === before) return s;
  }
}

const HTML_MARKERS =
  /^<(?:!doctype\s+html|html|head|body|script|iframe|object|embed|style|title|meta|link|a\s|div|p>|table|br|h1|img|form)/i;

function sniffText(buf: Uint8Array, truncated: boolean): SniffResult | undefined {
  if (!looksLikeText(buf, truncated)) return undefined;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const rest = stripLeadingTextNoise(text);
  if (/^<svg[\s>/]/i.test(rest)) return { type: 'image/svg+xml', scriptable: true };
  if (HTML_MARKERS.test(rest)) return { type: 'text/html', scriptable: true };
  // HTML fragments that are not at the very start still execute when rendered inline.
  if (/<script[\s>]/i.test(text) || /<html[\s>]/i.test(text)) {
    return { type: 'text/html', scriptable: true };
  }
  return { type: 'text/plain', scriptable: false };
}

/**
 * Detects a MIME type from the first bytes of a file. Recognises PNG, JPEG, GIF, WebP, BMP,
 * TIFF, ICO, HEIC, AVIF, PDF, ZIP, GZIP, 7z, MP4, QuickTime, M4A, WebM, AVI, Ogg, FLAC, MP3,
 * WAV, SVG, HTML and UTF-8 plain text. `truncated` states that more bytes follow the window.
 */
export function sniffContentType(head: Uint8Array, truncated = false): SniffResult {
  if (head.length === 0) return { scriptable: false };
  const binary = sniffBinary(head);
  if (binary) return { type: binary, scriptable: false };
  return sniffText(head, truncated) ?? { scriptable: false };
}

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/vnd.microsoft.icon',
  heic: 'image/heic',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/webm',
  avi: 'video/x-msvideo',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  ogv: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'text/html',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  jar: 'application/java-archive',
};

const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-ms-bmp': 'image/bmp',
  'image/x-icon': 'image/vnd.microsoft.icon',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-flac': 'audio/flac',
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip': 'application/zip',
  'application/x-gzip': 'application/gzip',
  'application/x-pdf': 'application/pdf',
  'video/x-matroska': 'video/webm',
  'video/ogg': 'audio/ogg',
  'application/ogg': 'audio/ogg',
  'application/x-javascript': 'text/javascript',
  'application/javascript': 'text/javascript',
  'text/xml': 'application/xml',
  'application/xhtml+xml': 'text/html',
  'text/x-markdown': 'text/markdown',
  'application/x-yaml': 'application/yaml',
  'text/yaml': 'application/yaml',
};

/** ZIP container formats: sniffed as application/zip. */
const ZIP_CONTAINERS = new Set([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
  'application/java-archive',
]);

/** ISO base media (ftyp) family members are interchangeable when declared. */
const ISO_MEDIA = new Set([
  'video/mp4',
  'video/quicktime',
  'audio/mp4',
  'image/heic',
  'image/avif',
]);

/** Types that sniffing detects; declaring one of these requires a matching signature. */
const SNIFFABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/heic',
  'image/avif',
  'application/pdf',
  'application/gzip',
  'application/x-7z-compressed',
  'video/mp4',
  'video/quicktime',
  'audio/mp4',
  'video/webm',
  'video/x-msvideo',
  'audio/ogg',
  'audio/flac',
  'audio/mpeg',
  'audio/wav',
  'image/svg+xml',
  'text/html',
  ...ZIP_CONTAINERS,
]);

const TEXTUAL_APPLICATION = new Set([
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/csv',
  'application/sql',
  'application/graphql',
  'application/ld+json',
  'application/geo+json',
]);

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Normalises a Content-Type value to a lowercase `type/subtype` without parameters and
 * resolves common aliases. Returns undefined for missing or malformed values.
 */
export function normalizeContentType(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const base = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!MIME_PATTERN.test(base)) return undefined;
  return ALIASES[base] ?? base;
}

/** Lowercase extension of a filename without the dot, or undefined. */
export function extensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

/** Canonical type for a filename extension, or undefined for unknown extensions. */
export function typeForExtension(filename: string): string | undefined {
  const ext = extensionOf(filename);
  return ext === undefined ? undefined : EXTENSION_TYPES[ext];
}

export function isTextualType(type: string): boolean {
  if (type === 'text/html') return false;
  return type.startsWith('text/') || TEXTUAL_APPLICATION.has(type) || type.endsWith('+json');
}

export function isSniffableType(type: string): boolean {
  return SNIFFABLE.has(type);
}

/**
 * Whether content detected as `detected` may legitimately be labelled `declared`.
 * `detected` undefined means no signature matched (unknown binary).
 */
export function isCompatibleType(declared: string, detected: string | undefined): boolean {
  if (declared === OCTET_STREAM) return true;
  if (detected === undefined) return !SNIFFABLE.has(declared) && !isTextualType(declared);
  if (declared === detected) return true;
  if (detected === 'application/zip') return ZIP_CONTAINERS.has(declared);
  if (ISO_MEDIA.has(detected)) return ISO_MEDIA.has(declared);
  if (detected === 'text/plain') return isTextualType(declared);
  return false;
}

/** Matches a MIME type against patterns such as `image/*`, `application/pdf` or `*\/*`. */
export function matchesTypePattern(type: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase();
    if (p === '*/*' || p === '*') return true;
    if (p.endsWith('/*')) {
      if (type.startsWith(p.slice(0, -1))) return true;
    } else if ((ALIASES[p] ?? p) === type) {
      return true;
    }
  }
  return false;
}

/** Types rendered inline on download. Everything else is served as an attachment. */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/flac',
  'text/plain',
]);

export function isInlineSafeType(type: string): boolean {
  return INLINE_SAFE.has(type);
}
