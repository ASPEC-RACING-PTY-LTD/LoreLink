import type { NavItem, PublicPage, PublicSearch, PublicSite, SearchResult, SiteVersion } from "./types";

export class PublicApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.code = code;
  }

  get needsSignIn(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

export function isPublicApiError(error: unknown): error is PublicApiError {
  return error instanceof PublicApiError;
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { credentials: "include", signal });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = {};
    }
  }
  if (!res.ok) {
    const err = asRecord(data).error;
    const info = asRecord(err);
    throw new PublicApiError(res.status, str(info, "code"), str(info, "message") || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function fetchPublicResolve(host: string, signal?: AbortSignal): Promise<{ org: string; project: string; base_path: string }> {
  const params = new URLSearchParams({ host });
  const raw = await request<Record<string, unknown>>(`/api/v1/public/resolve?${params}`, signal);
  return {
    org: String(raw.org ?? ""),
    project: String(raw.project ?? ""),
    base_path: String(raw.base_path ?? ""),
  };
}

export async function fetchPublicSite(
  orgSlug: string,
  projectSlug: string,
  version: string,
  signal?: AbortSignal,
): Promise<PublicSite> {
  const params = new URLSearchParams({ version: version || "latest" });
  const raw = await request<unknown>(`/api/v1/public/${enc(orgSlug)}/${enc(projectSlug)}?${params}`, signal);
  return normalizeSite(raw);
}

export async function fetchPublicPage(
  orgSlug: string,
  projectSlug: string,
  version: string,
  path: string,
  signal?: AbortSignal,
): Promise<PublicPage> {
  try {
    return await requestPage(orgSlug, projectSlug, version, path, signal);
  } catch (error) {
    const trimmed = path.replace(/^\/+/, "");
    if (isPublicApiError(error) && error.notFound && trimmed && !trimmed.startsWith("docs/")) {
      return requestPage(orgSlug, projectSlug, version, `docs/${trimmed}`, signal);
    }
    throw error;
  }
}

async function requestPage(
  orgSlug: string,
  projectSlug: string,
  version: string,
  path: string,
  signal?: AbortSignal,
): Promise<PublicPage> {
  const params = new URLSearchParams({ version: version || "latest" });
  if (path) {
    params.set("path", path);
  }
  const raw = await request<unknown>(`/api/v1/public/${enc(orgSlug)}/${enc(projectSlug)}/page?${params}`, signal);
  return normalizePage(raw);
}

export async function fetchPublicSearch(
  orgSlug: string,
  projectSlug: string,
  version: string,
  query: string,
  signal?: AbortSignal,
): Promise<PublicSearch> {
  const params = new URLSearchParams({ version: version || "latest", q: query });
  const raw = await request<unknown>(`/api/v1/public/${enc(orgSlug)}/${enc(projectSlug)}/search?${params}`, signal);
  return normalizeSearch(raw);
}

export function matchNavItem(nav: NavItem[], hint: string): NavItem | undefined {
  const trimmed = hint.replace(/^\/+/, "");
  const withoutMd = trimmed.replace(/\.md$/i, "");
  return nav.find((item) => {
    const itemPath = item.path.replace(/^\/+/, "");
    const itemWithoutMd = itemPath.replace(/\.md$/i, "");
    return (
      item.slug === trimmed ||
      item.slug === withoutMd ||
      itemPath === trimmed ||
      itemWithoutMd === withoutMd ||
      withoutMd.endsWith(`/${item.slug}`) ||
      withoutMd.endsWith(`/${itemWithoutMd}`) ||
      itemWithoutMd.endsWith(`/${withoutMd}`)
    );
  });
}

export function resolvePagePath(nav: NavItem[], pagePath: string): string {
  if (!pagePath) {
    const index = nav.find((item) => item.slug === "" || /(?:^|\/)index\.md$/i.test(item.path));
    return index?.path ?? nav[0]?.path ?? "";
  }
  return matchNavItem(nav, pagePath)?.path ?? withMarkdownSuffix(pagePath);
}

export function resolvePageSlug(nav: NavItem[], hint: string): string {
  return matchNavItem(nav, hint)?.slug ?? hint.replace(/\.md$/i, "");
}

function normalizeSite(raw: unknown): PublicSite {
  const data = asRecord(raw);
  const project = asRecord(data.project);
  return {
    project: {
      name: str(project, "name", "Name"),
      slug: str(project, "slug", "Slug"),
      org: str(project, "org", "Org"),
    },
    title: str(data, "title", "Title"),
    nav: asArray(data.nav).map(normalizeNavItem).filter((item) => item.path || item.slug || item.title),
    versions: asArray(data.versions).map(normalizeVersion).filter((item) => item.name),
    version: str(data, "version", "Version") || "latest",
  };
}

function normalizeNavItem(raw: unknown): NavItem {
  const data = asRecord(raw);
  return {
    title: str(data, "title", "Title"),
    path: str(data, "path", "Path"),
    slug: str(data, "slug", "Slug"),
  };
}

function normalizeVersion(raw: unknown): SiteVersion {
  const data = asRecord(raw);
  return {
    name: str(data, "name", "Name"),
    alias: str(data, "alias", "Alias"),
  };
}

function normalizePage(raw: unknown): PublicPage {
  const data = asRecord(raw);
  const doc = asRecord(data.doc);
  return {
    path: str(data, "path", "Path"),
    doc: {
      title: str(doc, "title", "Title"),
      html: str(doc, "html", "HTML", "Html"),
      headings: asArray(doc.headings ?? doc.Headings).map((item) => {
        const heading = asRecord(item);
        return {
          level: num(heading, "level", "Level") || 2,
          text: str(heading, "text", "Text"),
          id: str(heading, "id", "ID", "Id"),
        };
      }),
      description: str(doc, "description", "Description"),
    },
  };
}

function normalizeSearch(raw: unknown): PublicSearch {
  const data = asRecord(raw);
  return { results: asArray(data.results ?? data.Results).map(normalizeSearchResult) };
}

function normalizeSearchResult(raw: unknown): SearchResult {
  const data = asRecord(raw);
  return {
    path: str(data, "path", "Path"),
    title: str(data, "title", "Title"),
    headings: asText(data.headings ?? data.Headings),
    body: asText(data.body ?? data.Body),
  };
}

function withMarkdownSuffix(path: string): string {
  if (!path || /\.md$/i.test(path)) {
    return path;
  }
  return `${path}.md`;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function num(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join(" ");
  }
  return "";
}
