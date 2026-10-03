import { invalidConfig, NotificationsError } from './errors.js';
import {
  type CompiledTemplate,
  compileTemplate,
  htmlToText,
  type RenderOptions,
  renderCompiled,
} from './template.js';

/** Transactional email template: subject, optional text part and optional HTML part. */
export interface EmailTemplateDefinition {
  id: string;
  /** BCP 47 locale such as "en" or "fr-CA". Defaults to the registry default locale. */
  locale?: string;
  subject: string;
  /** Plain text part. Generated from the HTML part when omitted. */
  text?: string;
  html?: string;
  /** Layout ID. Defaults to the registry defaultLayout; use null to disable. */
  layout?: string | null;
  /** Variables that must be present (not undefined or null) in the render data. */
  requiredVariables?: readonly string[];
}

/** Notification template for non-email channels (in-app, Slack, webhooks, custom providers). */
export interface NotificationTemplateDefinition {
  id: string;
  /** Channel name, or "*" (default) for every non-email channel. */
  channel?: string;
  locale?: string;
  title: string;
  body: string;
  /** Optional link, for example the page the notification refers to. */
  url?: string;
  requiredVariables?: readonly string[];
}

/** Layout wrapping email bodies. Use {{> @content}} where the body goes. */
export interface LayoutDefinition {
  id: string;
  locale?: string;
  html?: string;
  text?: string;
}

export interface TemplateRegistryOptions {
  /** Fallback locale. Default "en". */
  defaultLocale?: string;
  /** Layout applied to email templates that do not set layout. */
  defaultLayout?: string;
  /** Throw when an output tag references an undefined variable. Default true. */
  strict?: boolean;
  email?: readonly EmailTemplateDefinition[];
  notifications?: readonly NotificationTemplateDefinition[];
  layouts?: readonly LayoutDefinition[];
  /** Partials by name, included with {{> name}}. */
  partials?: Readonly<Record<string, string>>;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html?: string;
  /** Locale of the template that was used after fallback. */
  locale: string;
}

export interface RenderedNotification {
  title: string;
  body: string;
  url?: string;
  locale: string;
}

export interface TemplateRegistry {
  readonly defaultLocale: string;
  registerEmail(definition: EmailTemplateDefinition): void;
  registerNotification(definition: NotificationTemplateDefinition): void;
  registerLayout(definition: LayoutDefinition): void;
  registerPartial(name: string, source: string): void;
  hasEmail(id: string): boolean;
  hasNotification(id: string, channel: string): boolean;
  renderEmail(
    id: string,
    data: Record<string, unknown>,
    options?: { locale?: string },
  ): RenderedEmail;
  renderNotification(
    id: string,
    channel: string,
    data: Record<string, unknown>,
    options?: { locale?: string },
  ): RenderedNotification;
}

interface CompiledEmail {
  id: string;
  locale: string;
  subject: CompiledTemplate;
  text?: CompiledTemplate;
  html?: CompiledTemplate;
  layout: string | null | undefined;
  required: readonly string[];
}

interface CompiledNotification {
  id: string;
  locale: string;
  title: CompiledTemplate;
  body: CompiledTemplate;
  url?: CompiledTemplate;
  required: readonly string[];
}

interface CompiledLayout {
  html?: CompiledTemplate;
  text?: CompiledTemplate;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** Normalises a locale for case-insensitive lookups: "fr_CA" becomes "fr-ca". */
export function normalizeLocale(locale: string): string {
  return locale.trim().replace(/_/g, '-').toLowerCase();
}

/** Fallback chain for a locale: "fr-CA" gives ["fr-ca", "fr", <default>]. */
export function localeChain(locale: string | undefined, defaultLocale: string): string[] {
  const chain: string[] = [];
  if (locale !== undefined && LOCALE_PATTERN.test(locale.replace(/_/g, '-'))) {
    const parts = normalizeLocale(locale).split('-');
    for (let i = parts.length; i > 0; i--) chain.push(parts.slice(0, i).join('-'));
  }
  const def = normalizeLocale(defaultLocale);
  for (const part of [def, def.split('-')[0] as string]) {
    if (!chain.includes(part)) chain.push(part);
  }
  return chain;
}

function checkId(kind: string, id: unknown): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw invalidConfig(`${kind}.id`, 'must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
  }
  return id;
}

function checkLocale(kind: string, locale: string | undefined, fallback: string): string {
  const value = locale ?? fallback;
  if (!LOCALE_PATTERN.test(value.replace(/_/g, '-'))) {
    throw invalidConfig(`${kind}.locale`, `"${value}" is not a valid locale`);
  }
  return normalizeLocale(value);
}

function missingRequired(
  templateName: string,
  required: readonly string[],
  data: Record<string, unknown>,
): void {
  const missing = required.filter((name) => {
    let value: unknown = data;
    for (const part of name.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return true;
      value = (value as Record<string, unknown>)[part];
    }
    return value === undefined || value === null;
  });
  if (missing.length > 0) {
    throw new NotificationsError(
      'NOTIFICATIONS_TEMPLATE_VARIABLE_MISSING',
      `Template "${templateName}" is missing required variables: ${missing.join(', ')}`,
      { status: 500, expose: false, details: { template: templateName, missing } },
    );
  }
}

/** Creates a registry of transactional email templates, notification templates, layouts and partials. */
export function createTemplateRegistry(options: TemplateRegistryOptions = {}): TemplateRegistry {
  const defaultLocale = options.defaultLocale ?? 'en';
  if (!LOCALE_PATTERN.test(defaultLocale)) {
    throw invalidConfig('templates.defaultLocale', `"${defaultLocale}" is not a valid locale`);
  }
  const strict = options.strict ?? true;
  const emails = new Map<string, CompiledEmail>();
  const notifications = new Map<string, CompiledNotification>();
  const layouts = new Map<string, CompiledLayout>();
  const partials = new Map<string, CompiledTemplate>();
  const key = (...parts: string[]): string => parts.join('\u0000');

  const registry: TemplateRegistry = {
    defaultLocale,
    registerEmail(def) {
      const id = checkId('email', def.id);
      const locale = checkLocale('email', def.locale, defaultLocale);
      if (typeof def.subject !== 'string' || def.subject.trim() === '') {
        throw invalidConfig('email.subject', `template "${id}" needs a subject`);
      }
      if (def.text === undefined && def.html === undefined) {
        throw invalidConfig('email', `template "${id}" needs a text or html part`);
      }
      const name = `${id}@${locale}`;
      const compiled: CompiledEmail = {
        id,
        locale,
        subject: compileTemplate(def.subject, `${name}#subject`),
        layout: def.layout,
        required: def.requiredVariables ?? [],
      };
      if (def.text !== undefined) compiled.text = compileTemplate(def.text, `${name}#text`);
      if (def.html !== undefined) compiled.html = compileTemplate(def.html, `${name}#html`);
      emails.set(key(id, locale), compiled);
    },
    registerNotification(def) {
      const id = checkId('notification', def.id);
      const locale = checkLocale('notification', def.locale, defaultLocale);
      const channel = def.channel ?? '*';
      const name = `${id}@${locale}/${channel}`;
      const compiled: CompiledNotification = {
        id,
        locale,
        title: compileTemplate(def.title, `${name}#title`),
        body: compileTemplate(def.body, `${name}#body`),
        required: def.requiredVariables ?? [],
      };
      if (def.url !== undefined) compiled.url = compileTemplate(def.url, `${name}#url`);
      notifications.set(key(id, channel, locale), compiled);
    },
    registerLayout(def) {
      const id = checkId('layout', def.id);
      const locale = checkLocale('layout', def.locale, defaultLocale);
      const compiled: CompiledLayout = {};
      if (def.html !== undefined)
        compiled.html = compileTemplate(def.html, `layout:${id}@${locale}#html`);
      if (def.text !== undefined)
        compiled.text = compileTemplate(def.text, `layout:${id}@${locale}#text`);
      layouts.set(key(id, locale), compiled);
    },
    registerPartial(name, source) {
      checkId('partial', name);
      partials.set(name, compileTemplate(source, `partial:${name}`));
    },
    hasEmail(id) {
      for (const k of emails.keys()) if (k.startsWith(`${id}\u0000`)) return true;
      return false;
    },
    hasNotification(id, channel) {
      for (const k of notifications.keys()) {
        if (k.startsWith(`${id}\u0000${channel}\u0000`) || k.startsWith(`${id}\u0000*\u0000`))
          return true;
      }
      return false;
    },
    renderEmail(id, data, renderOptions = {}) {
      const chain = localeChain(renderOptions.locale, defaultLocale);
      let template: CompiledEmail | undefined;
      for (const locale of chain) {
        template = emails.get(key(id, locale));
        if (template !== undefined) break;
      }
      if (template === undefined) {
        throw new NotificationsError(
          'NOTIFICATIONS_TEMPLATE_NOT_FOUND',
          `Email template "${id}" is not registered for locales ${chain.join(', ')}`,
          { status: 500, expose: false },
        );
      }
      missingRequired(`${template.id}@${template.locale}`, template.required, data);
      const base: Omit<RenderOptions, 'mode'> = { partials, strict };
      const subject = renderCompiled(template.subject, data, { ...base, mode: 'text' })
        .replace(/[\r\n]+/g, ' ')
        .trim();
      const layoutId = template.layout === undefined ? options.defaultLayout : template.layout;
      let layout: CompiledLayout | undefined;
      if (layoutId !== undefined && layoutId !== null) {
        for (const locale of localeChain(template.locale, defaultLocale)) {
          layout = layouts.get(key(layoutId, locale));
          if (layout !== undefined) break;
        }
        if (layout === undefined) {
          throw new NotificationsError(
            'NOTIFICATIONS_TEMPLATE_NOT_FOUND',
            `Layout "${layoutId}" used by email template "${id}" is not registered`,
            { status: 500, expose: false },
          );
        }
      }
      let innerHtml: string | undefined;
      if (template.html !== undefined) {
        innerHtml = renderCompiled(template.html, data, { ...base, mode: 'html' });
      }
      let text =
        template.text !== undefined
          ? renderCompiled(template.text, data, { ...base, mode: 'text' })
          : htmlToText(innerHtml ?? '');
      if (layout?.text !== undefined) {
        text = renderCompiled(layout.text, data, { ...base, mode: 'text', content: text });
      }
      const result: RenderedEmail = { subject, text, locale: template.locale };
      if (innerHtml !== undefined) {
        result.html =
          layout?.html !== undefined
            ? renderCompiled(layout.html, data, { ...base, mode: 'html', content: innerHtml })
            : innerHtml;
      }
      return result;
    },
    renderNotification(id, channel, data, renderOptions = {}) {
      const chain = localeChain(renderOptions.locale, defaultLocale);
      let template: CompiledNotification | undefined;
      outer: for (const ch of [channel, '*']) {
        for (const locale of chain) {
          template = notifications.get(key(id, ch, locale));
          if (template !== undefined) break outer;
        }
      }
      if (template === undefined) {
        throw new NotificationsError(
          'NOTIFICATIONS_TEMPLATE_NOT_FOUND',
          `Notification template "${id}" is not registered for channel "${channel}"`,
          { status: 500, expose: false },
        );
      }
      missingRequired(`${template.id}@${template.locale}`, template.required, data);
      const opts: RenderOptions = { partials, strict, mode: 'text' };
      const result: RenderedNotification = {
        title: renderCompiled(template.title, data, opts).trim(),
        body: renderCompiled(template.body, data, opts).trim(),
        locale: template.locale,
      };
      if (template.url !== undefined) result.url = renderCompiled(template.url, data, opts).trim();
      return result;
    },
  };

  for (const [name, source] of Object.entries(options.partials ?? {})) {
    registry.registerPartial(name, source);
  }
  for (const def of options.layouts ?? []) registry.registerLayout(def);
  for (const def of options.email ?? []) registry.registerEmail(def);
  for (const def of options.notifications ?? []) registry.registerNotification(def);
  return registry;
}
