import { describe, expect, it } from 'vitest';
import { NotificationsError } from '../src/errors.js';
import { compileTemplate, htmlToText, renderTemplate } from '../src/template.js';
import { createTemplateRegistry, localeChain } from '../src/templates.js';

const html = (source: string, data: Record<string, unknown>) =>
  renderTemplate(source, data, { mode: 'html' });

describe('template syntax', () => {
  it('escapes HTML by default and only outputs raw with triple braces', () => {
    const data = { name: '<script>alert("x")</script> & \'co\'' };
    expect(html('Hi {{ name }}', data)).toBe(
      'Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;',
    );
    expect(html('Hi {{{ name }}}', data)).toBe(`Hi ${data.name}`);
    expect(renderTemplate('Hi {{ name }}', data, { mode: 'text' })).toBe(`Hi ${data.name}`);
  });

  it('supports if, unless, else, each with index, first, last and nested paths', () => {
    const out = html(
      '{{#if user.admin}}admin{{else}}user{{/if}}|{{#unless missing}}no{{/unless}}|{{#each items}}{{ @index }}:{{ name }}{{#if @last}}.{{else}},{{/if}}{{/each}}|{{#each empty}}x{{else}}none{{/each}}',
      { user: { admin: false }, missing: '', items: [{ name: 'a' }, { name: 'b' }], empty: [] },
    );
    expect(out).toBe('user|no|0:a,1:b.|none');
  });

  it('reads the current item with . and this, and outer scopes from inside each', () => {
    expect(
      html('{{#each tags}}[{{ . }}/{{ this }}/{{ owner }}]{{/each}}', {
        tags: ['x', 'y'],
        owner: 'o',
      }),
    ).toBe('[x/x/o][y/y/o]');
  });

  it('throws on undefined variables in strict mode and renders empty when not strict', () => {
    expect(() => html('Hi {{ name }}', {})).toThrowError(
      expect.objectContaining({ code: 'NOTIFICATIONS_TEMPLATE_VARIABLE_MISSING' }),
    );
    expect(renderTemplate('Hi {{ name }}!', {}, { mode: 'html', strict: false })).toBe('Hi !');
    expect(html('{{#if name}}{{ name }}{{/if}}ok', {})).toBe('ok');
  });

  it('never reads inherited or prototype properties', () => {
    expect(() => compileTemplate('{{ __proto__ }}')).toThrowError(NotificationsError);
    expect(() => compileTemplate('{{ a.constructor }}')).toThrowError(NotificationsError);
    expect(renderTemplate('{{ toString }}', {}, { mode: 'text', strict: false })).toBe('');
    const inherited = Object.create({ secret: 'leak' }) as Record<string, unknown>;
    expect(renderTemplate('{{ secret }}', inherited, { mode: 'text', strict: false })).toBe('');
  });

  it('rejects malformed templates', () => {
    for (const bad of [
      '{{#if a}}x',
      '{{/if}}',
      '{{#if a}}{{else}}{{else}}{{/if}}',
      '{{ a b }}',
      '{{}}',
      '{{#each}}{{/each}}',
      '{{#with a}}{{/with}}',
      '{{#if a}}{{/each}}',
    ]) {
      expect(() => compileTemplate(bad), bad).toThrowError(
        expect.objectContaining({ code: 'NOTIFICATIONS_TEMPLATE_SYNTAX' }),
      );
    }
  });

  it('ignores comments', () => {
    expect(html('a{{! hidden }}b', {})).toBe('ab');
  });
});

describe('htmlToText', () => {
  it('produces readable text with links, lists and entities', () => {
    const text = htmlToText(
      '<html><head><title>T</title><style>p{color:red}</style></head><body><h1>Welcome &amp; hello</h1><p>Click <a href="https://example.test/verify?a=1&amp;b=2">here</a>.</p><ul><li>One</li><li>Two</li></ul><p>Line<br>break</p><script>evil()</script></body></html>',
    );
    expect(text).toBe(
      'Welcome & hello\n\nClick here (https://example.test/verify?a=1&b=2).\n\n- One\n- Two\n\nLine\nbreak',
    );
  });
});

describe('template registry', () => {
  const registry = createTemplateRegistry({
    defaultLocale: 'en',
    defaultLayout: 'main',
    partials: { footer: '<p>Sent by {{ app }}</p>' },
    layouts: [
      {
        id: 'main',
        html: '<main>{{> @content}}{{> footer}}</main>',
        text: '{{> @content}}\n-- {{ app }}',
      },
      { id: 'main', locale: 'fr', html: '<main lang="fr">{{> @content}}</main>' },
    ],
    email: [
      {
        id: 'welcome',
        subject: 'Welcome {{ name }}',
        html: '<p>Hello <b>{{ name }}</b></p>',
        requiredVariables: ['name', 'app'],
      },
      {
        id: 'welcome',
        locale: 'fr',
        subject: 'Bienvenue {{ name }}',
        html: '<p>Bonjour {{ name }}</p>',
      },
      { id: 'plain', subject: 'Plain\r\nBcc: x@evil.test', text: 'Text {{ code }}', layout: null },
    ],
    notifications: [
      { id: 'welcome', title: 'Welcome {{ name }}', body: 'Hello {{ name }}', url: '/welcome' },
      { id: 'welcome', channel: 'slack', title: 'Slack welcome {{ name }}', body: 'Hi' },
    ],
  });

  it('applies layouts, partials and generates text from HTML', () => {
    const r = registry.renderEmail('welcome', { name: '<Ann>', app: 'Acme' });
    expect(r.subject).toBe('Welcome <Ann>');
    expect(r.html).toBe('<main><p>Hello <b>&lt;Ann&gt;</b></p><p>Sent by Acme</p></main>');
    expect(r.text).toBe('Hello <Ann>\n-- Acme');
    expect(r.locale).toBe('en');
  });

  it('falls back from region to language to default locale', () => {
    expect(localeChain('fr-CA', 'en')).toEqual(['fr-ca', 'fr', 'en']);
    expect(localeChain('fr_CA', 'en-GB')).toEqual(['fr-ca', 'fr', 'en-gb', 'en']);
    const fr = registry.renderEmail('welcome', { name: 'Zoé', app: 'Acme' }, { locale: 'fr-CA' });
    expect(fr.subject).toBe('Bienvenue Zoé');
    expect(fr.locale).toBe('fr');
    expect(fr.html).toBe('<main lang="fr"><p>Bonjour Zoé</p></main>');
    const de = registry.renderEmail('welcome', { name: 'Max', app: 'Acme' }, { locale: 'de-AT' });
    expect(de.locale).toBe('en');
    expect(
      registry.renderEmail('welcome', { name: 'X', app: 'A' }, { locale: '../../etc' }).locale,
    ).toBe('en');
  });

  it('checks required variables', () => {
    expect(() => registry.renderEmail('welcome', { name: 'Ann' })).toThrowError(
      expect.objectContaining({
        code: 'NOTIFICATIONS_TEMPLATE_VARIABLE_MISSING',
        details: expect.objectContaining({ missing: ['app'] }),
      }),
    );
  });

  it('removes line breaks from subjects (header injection)', () => {
    expect(registry.renderEmail('plain', { code: 1 }).subject).toBe('Plain Bcc: x@evil.test');
  });

  it('renders channel specific notification templates with a generic fallback', () => {
    expect(registry.renderNotification('welcome', 'in-app', { name: 'Ann' })).toEqual({
      title: 'Welcome Ann',
      body: 'Hello Ann',
      url: '/welcome',
      locale: 'en',
    });
    expect(registry.renderNotification('welcome', 'slack', { name: 'Ann' }).title).toBe(
      'Slack welcome Ann',
    );
    expect(registry.hasNotification('welcome', 'anything')).toBe(true);
    expect(registry.hasEmail('missing')).toBe(false);
    expect(() => registry.renderEmail('missing', {})).toThrowError(
      expect.objectContaining({ code: 'NOTIFICATIONS_TEMPLATE_NOT_FOUND' }),
    );
  });

  it('validates definitions at registration', () => {
    expect(() => registry.registerEmail({ id: 'bad id', subject: 's', text: 't' })).toThrowError(
      expect.objectContaining({ code: 'NOTIFICATIONS_INVALID_CONFIG' }),
    );
    expect(() => registry.registerEmail({ id: 'x', subject: 's' })).toThrowError(
      expect.objectContaining({ code: 'NOTIFICATIONS_INVALID_CONFIG' }),
    );
    expect(() => registry.registerEmail({ id: 'x', subject: '{{#if a}}', text: 't' })).toThrowError(
      expect.objectContaining({ code: 'NOTIFICATIONS_TEMPLATE_SYNTAX' }),
    );
  });
});
