import { invalidConfig } from './errors.js';
import type { PreferenceRecord } from './types.js';

export interface CategoryConfig {
  /** Mandatory categories (security, account notices) ignore opt-outs and cannot be disabled. */
  mandatory?: boolean;
  /** Channels enabled by default. Other configured channels are opt-in. */
  channels?: readonly string[];
  description?: string;
}

export interface PreferencesConfig {
  /**
   * Category configuration. Keys are exact categories ("auth.password-reset"), prefix
   * wildcards ("auth.*") or "*". The most specific match wins.
   */
  categories?: Readonly<Record<string, CategoryConfig>>;
  /** Default channels for categories without configured channels. Default: every channel. */
  defaultChannels?: readonly string[];
}

export interface EffectivePreference {
  category: string;
  channel: string;
  enabled: boolean;
  mandatory: boolean;
  /** "mandatory", "user" (explicit preference) or "default". */
  source: 'mandatory' | 'user' | 'default';
}

const CATEGORY_KEY = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:\.\*)?)$/;
export const CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PreferenceResolver {
  categoryConfig(category: string): CategoryConfig | undefined;
  isMandatory(category: string): boolean;
  defaultChannels(category: string, available: readonly string[]): string[];
  resolve(
    category: string,
    channel: string,
    records: readonly PreferenceRecord[],
    available: readonly string[],
  ): EffectivePreference;
  /**
   * Channels considered for a notification: the category defaults plus channels the user
   * explicitly opted into. Opted-out defaults stay in the list so they are recorded as skipped.
   */
  candidateChannels(
    category: string,
    records: readonly PreferenceRecord[],
    available: readonly string[],
  ): string[];
  readonly configuredCategories: readonly string[];
}

export function createPreferenceResolver(config: PreferencesConfig = {}): PreferenceResolver {
  const categories = config.categories ?? {};
  for (const [key, value] of Object.entries(categories)) {
    if (!CATEGORY_KEY.test(key))
      throw invalidConfig(`preferences.categories.${key}`, 'invalid category key');
    for (const ch of value.channels ?? []) {
      if (!CHANNEL_PATTERN.test(ch)) {
        throw invalidConfig(`preferences.categories.${key}.channels`, `invalid channel "${ch}"`);
      }
    }
  }
  const prefixes = Object.keys(categories)
    .filter((k) => k.endsWith('.*'))
    .sort((a, b) => b.length - a.length);

  const categoryConfig = (category: string): CategoryConfig | undefined => {
    if (Object.hasOwn(categories, category)) return categories[category];
    for (const prefix of prefixes) {
      if (category.startsWith(prefix.slice(0, -1))) return categories[prefix];
    }
    return Object.hasOwn(categories, '*') ? categories['*'] : undefined;
  };

  const defaultChannels = (category: string, available: readonly string[]): string[] => {
    const configured = categoryConfig(category)?.channels ?? config.defaultChannels;
    if (configured === undefined) return [...available];
    return configured.filter((ch) => available.includes(ch));
  };

  const findRecord = (
    records: readonly PreferenceRecord[],
    category: string,
    channel: string,
  ): PreferenceRecord | undefined => {
    const exact = records.find((r) => r.category === category && r.channel === channel);
    if (exact) return exact;
    const anyChannel = records.find((r) => r.category === category && r.channel === '*');
    if (anyChannel) return anyChannel;
    const anyCategory = records.find((r) => r.category === '*' && r.channel === channel);
    if (anyCategory) return anyCategory;
    return records.find((r) => r.category === '*' && r.channel === '*');
  };

  const resolver: PreferenceResolver = {
    configuredCategories: Object.keys(categories),
    categoryConfig,
    isMandatory: (category) => categoryConfig(category)?.mandatory === true,
    defaultChannels,
    resolve(category, channel, records, available) {
      const isDefault = defaultChannels(category, available).includes(channel);
      if (categoryConfig(category)?.mandatory === true) {
        return { category, channel, enabled: isDefault, mandatory: true, source: 'mandatory' };
      }
      const record = findRecord(records, category, channel);
      if (record) {
        return { category, channel, enabled: record.enabled, mandatory: false, source: 'user' };
      }
      return { category, channel, enabled: isDefault, mandatory: false, source: 'default' };
    },
    candidateChannels(category, records, available) {
      const defaults = defaultChannels(category, available);
      return available.filter((ch) => {
        if (defaults.includes(ch)) return true;
        if (categoryConfig(category)?.mandatory === true) return false;
        return findRecord(records, category, ch)?.enabled === true;
      });
    },
  };
  return resolver;
}
