import { NotificationsError } from './errors.js';

/**
 * A small, logic-less template language. It never evaluates code; templates can only read
 * values from the data object.
 *
 *   {{ path }}               value, HTML-escaped in HTML templates
 *   {{{ path }}}             raw value (no escaping); use only for trusted HTML
 *   {{#if path}} {{else}} {{/if}}, {{#unless path}} ... {{/unless}}
 *   {{#each path}} {{ . }} {{ @index }} {{else}} {{/each}}
 *   {{> partialName}}        include a registered partial
 *   {{> @content}}           in layouts: the rendered template body
 *   {{! comment }}
 */

export type TemplateMode = 'html' | 'text';

type Node =
  | { type: 'text'; value: string }
  | { type: 'var'; path: string[]; raw: boolean; source: string }
  | { type: 'if'; path: string[]; negate: boolean; consequent: Node[]; else: Node[] }
  | { type: 'each'; path: string[]; body: Node[]; else: Node[] }
  | { type: 'partial'; name: string }
  | { type: 'content' };

export interface CompiledTemplate {
  readonly name: string;
  /** @internal */
  readonly nodes: readonly Node[];
}

export interface RenderOptions {
  mode: TemplateMode;
  /** Partials available through {{> name}}. */
  partials?: ReadonlyMap<string, CompiledTemplate>;
  /** Rendered body inserted by {{> @content}} (layouts only). Inserted without escaping. */
  content?: string;
  /** Throw when an output tag references an undefined value. Default true. */
  strict?: boolean;
}

const TAG = /\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}/g;
const PATH = /^(?:\.|@index|@first|@last|[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*|\.\d+)*)$/;
const PARTIAL_NAME = /^(?:@content|[A-Za-z0-9_][\w.-]*)$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PARTIAL_DEPTH = 10;

function syntaxError(name: string, message: string): NotificationsError {
  return new NotificationsError('NOTIFICATIONS_TEMPLATE_SYNTAX', `Template "${name}": ${message}`, {
    status: 500,
    expose: false,
  });
}

function parsePath(name: string, expr: string): string[] {
  if (!PATH.test(expr)) throw syntaxError(name, `invalid path "${expr}"`);
  if (expr === '.' || expr.startsWith('@')) return [expr];
  const parts = expr.split('.');
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) throw syntaxError(name, `forbidden path segment "${part}"`);
  }
  if (parts[0] === 'this') parts[0] = '.';
  return parts;
}

interface Frame {
  kind: 'root' | 'if' | 'unless' | 'each';
  nodes: Node[];
  owner?: Extract<Node, { type: 'if' | 'each' }>;
  inElse: boolean;
}

/** Parses a template. Throws NOTIFICATIONS_TEMPLATE_SYNTAX on malformed input. */
export function compileTemplate(source: string, name = 'template'): CompiledTemplate {
  if (typeof source !== 'string') throw syntaxError(name, 'source must be a string');
  const root: Frame = { kind: 'root', nodes: [], inElse: false };
  const stack: Frame[] = [root];
  const current = (): Frame => stack[stack.length - 1] as Frame;
  let last = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(source); m !== null; m = TAG.exec(source)) {
    if (m.index > last) current().nodes.push({ type: 'text', value: source.slice(last, m.index) });
    last = m.index + m[0].length;
    const triple = m[1] !== undefined;
    const body = (triple ? m[1] : m[2]) ?? '';
    if (body === '') throw syntaxError(name, 'empty tag');
    if (triple) {
      current().nodes.push({ type: 'var', path: parsePath(name, body), raw: true, source: body });
      continue;
    }
    const head = body[0];
    if (head === '!') continue;
    if (head === '>') {
      const partial = body.slice(1).trim();
      if (!PARTIAL_NAME.test(partial)) throw syntaxError(name, `invalid partial name "${partial}"`);
      current().nodes.push(
        partial === '@content' ? { type: 'content' } : { type: 'partial', name: partial },
      );
      continue;
    }
    if (head === '#') {
      const [keyword, ...rest] = body.slice(1).trim().split(/\s+/);
      const expr = rest.join(' ');
      if (rest.length !== 1)
        throw syntaxError(name, `block "${keyword ?? ''}" needs exactly one path`);
      if (keyword === 'if' || keyword === 'unless') {
        const node: Extract<Node, { type: 'if' }> = {
          type: 'if',
          path: parsePath(name, expr),
          negate: keyword === 'unless',
          consequent: [],
          else: [],
        };
        current().nodes.push(node);
        stack.push({ kind: keyword, nodes: node.consequent, owner: node, inElse: false });
        continue;
      }
      if (keyword === 'each') {
        const node: Extract<Node, { type: 'each' }> = {
          type: 'each',
          path: parsePath(name, expr),
          body: [],
          else: [],
        };
        current().nodes.push(node);
        stack.push({ kind: 'each', nodes: node.body, owner: node, inElse: false });
        continue;
      }
      throw syntaxError(name, `unknown block "${keyword ?? ''}"`);
    }
    if (head === '/') {
      const keyword = body.slice(1).trim();
      const frame = current();
      if (frame.kind === 'root' || frame.kind !== keyword) {
        throw syntaxError(name, `unexpected closing tag "{{/${keyword}}}"`);
      }
      stack.pop();
      continue;
    }
    if (body === 'else') {
      const frame = current();
      if (frame.kind === 'root' || frame.inElse || frame.owner === undefined) {
        throw syntaxError(name, 'unexpected {{else}}');
      }
      frame.inElse = true;
      frame.nodes = frame.owner.else;
      continue;
    }
    current().nodes.push({ type: 'var', path: parsePath(name, body), raw: false, source: body });
  }
  if (last < source.length) current().nodes.push({ type: 'text', value: source.slice(last) });
  if (stack.length !== 1) throw syntaxError(name, `unclosed block "{{#${current().kind}}}"`);
  return { name, nodes: root.nodes };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

interface Scope {
  value: unknown;
  index?: number;
  length?: number;
}

function readOwn(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj) && /^\d+$/.test(key)) return obj[Number(key)];
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

function lookup(scopes: readonly Scope[], path: readonly string[]): unknown {
  const first = path[0] as string;
  const inner = scopes[scopes.length - 1] as Scope;
  if (first === '@index') return inner.index;
  if (first === '@first') return inner.index === undefined ? undefined : inner.index === 0;
  if (first === '@last') {
    return inner.index === undefined || inner.length === undefined
      ? undefined
      : inner.index === inner.length - 1;
  }
  let value: unknown;
  if (first === '.') {
    value = inner.value;
  } else {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i] as Scope;
      if (
        scope.value !== null &&
        typeof scope.value === 'object' &&
        Object.hasOwn(scope.value, first)
      ) {
        value = (scope.value as Record<string, unknown>)[first];
        break;
      }
    }
  }
  for (let i = 1; i < path.length; i++) value = readOwn(value, path[i] as string);
  return value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? '';
}

function renderNodes(
  template: CompiledTemplate,
  nodes: readonly Node[],
  scopes: Scope[],
  options: RenderOptions,
  depth: number,
  out: string[],
): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(node.value);
        break;
      case 'var': {
        const value = lookup(scopes, node.path);
        if (value === undefined && options.strict !== false) {
          throw new NotificationsError(
            'NOTIFICATIONS_TEMPLATE_VARIABLE_MISSING',
            `Template "${template.name}": variable "${node.source}" is not defined`,
            {
              status: 500,
              expose: false,
              details: { template: template.name, variable: node.source },
            },
          );
        }
        const text = stringify(value);
        out.push(options.mode === 'html' && !node.raw ? escapeHtml(text) : text);
        break;
      }
      case 'if': {
        const cond = truthy(lookup(scopes, node.path)) !== node.negate;
        renderNodes(template, cond ? node.consequent : node.else, scopes, options, depth, out);
        break;
      }
      case 'each': {
        const list = lookup(scopes, node.path);
        if (Array.isArray(list) && list.length > 0) {
          list.forEach((item, index) => {
            scopes.push({ value: item, index, length: list.length });
            try {
              renderNodes(template, node.body, scopes, options, depth, out);
            } finally {
              scopes.pop();
            }
          });
        } else {
          renderNodes(template, node.else, scopes, options, depth, out);
        }
        break;
      }
      case 'partial': {
        const partial = options.partials?.get(node.name);
        if (partial === undefined) {
          throw new NotificationsError(
            'NOTIFICATIONS_TEMPLATE_NOT_FOUND',
            `Template "${template.name}": partial "${node.name}" is not registered`,
            { status: 500, expose: false },
          );
        }
        if (depth >= MAX_PARTIAL_DEPTH) {
          throw syntaxError(
            template.name,
            `partials nested deeper than ${MAX_PARTIAL_DEPTH} levels`,
          );
        }
        renderNodes(partial, partial.nodes, scopes, options, depth + 1, out);
        break;
      }
      case 'content':
        out.push(options.content ?? '');
        break;
    }
  }
}

/** Renders a compiled template with data. */
export function renderCompiled(
  template: CompiledTemplate,
  data: Record<string, unknown>,
  options: RenderOptions,
): string {
  const out: string[] = [];
  renderNodes(template, template.nodes, [{ value: data }], options, 0, out);
  return out.join('');
}

/** Compiles and renders a template in one step. Prefer compileTemplate for repeated use. */
export function renderTemplate(
  source: string,
  data: Record<string, unknown>,
  options: RenderOptions,
): string {
  return renderCompiled(compileTemplate(source), data, options);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '\u00a9',
  reg: '\u00ae',
  hellip: '...',
  mdash: '-',
  ndash: '-',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code === 0x2014) return '-';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/**
 * Produces a readable plain text alternative from HTML: removes head, style and script
 * content, keeps link targets, turns block elements into line breaks and list items into
 * bullets, and decodes entities.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(
      /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, _q, dq: string | undefined, sq: string | undefined, inner: string) => {
        const href = decodeEntities(dq ?? sq ?? '').trim();
        const label = inner.replace(/<[^>]+>/g, '').trim();
        if (href === '' || href.startsWith('#')) return label;
        if (label === '' || decodeEntities(label) === href) return href;
        return `${label} (${href})`;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/(p|div|h[1-6]|table|tr|ul|ol|blockquote|section|article|header|footer)\s*>/gi,
      '\n\n',
    )
    .replace(
      /<(p|div|h[1-6]|table|tr|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
