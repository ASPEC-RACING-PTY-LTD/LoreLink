import { DARK_THEME, initTheme, toggleTheme, type LoreLinkTheme } from "@lorelink/shared/theme";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { fetchPublicPage, fetchPublicResolve, fetchPublicSite, isPublicApiError, resolvePagePath } from "./api";
import { navigateTo, usePathname } from "./location";
import { parseViewPath, viewHref } from "./routing";
import { SearchModal } from "./SearchModal";
import type { NavItem, PublicDoc, PublicPage, PublicSite } from "./types";

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: unknown };

export function DocsShell() {
  const pathname = usePathname();
  const route = useMemo(() => parseViewPath(pathname), [pathname]);
  const [theme, setTheme] = useState<LoreLinkTheme>(() => initTheme());
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [siteState, setSiteState] = useState<LoadState<PublicSite>>({ status: "idle" });
  const [pageState, setPageState] = useState<LoadState<PublicPage>>({ status: "idle" });
  const [activeHeading, setActiveHeading] = useState("");

  const site = siteState.status === "ok" ? siteState.data : null;
  const page = pageState.status === "ok" ? pageState.data : null;
  const nav = site?.nav ?? [];
  const version = route.kind === "site" ? route.version : "latest";
  const currentSlug = useMemo(() => {
    if (route.kind !== "site") {
      return "";
    }
    if (route.pagePath) {
      return route.pagePath;
    }
    const index = nav.find((item) => item.slug === "" || /(?:^|\/)index\.md$/i.test(item.path));
    return index?.slug ?? nav[0]?.slug ?? "";
  }, [route, nav]);
  const currentIndex = useMemo(() => currentNavIndex(nav, currentSlug, page?.path ?? ""), [nav, currentSlug, page?.path]);
  const prev = currentIndex > 0 ? nav[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 && currentIndex < nav.length - 1 ? nav[currentIndex + 1] : undefined;
  const versionOptions = useMemo(() => versionChoices(site, version), [site, version]);
  const siteError = siteState.status === "error" ? siteState.error : null;
  const pageError = pageState.status === "error" ? pageState.error : null;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

  useEffect(() => {
    if (route.kind !== "directory") {
      return;
    }
    const host = window.location.hostname;
    if (!host || host === "localhost" || host === "127.0.0.1") {
      return;
    }
    const ac = new AbortController();
    fetchPublicResolve(host, ac.signal)
      .then((resolved) => {
        if (resolved.org && resolved.project) {
          navigateTo(viewHref(resolved.org, resolved.project, "latest"));
        }
      })
      .catch(() => {
        /* keep the directory empty state */
      });
    return () => ac.abort();
  }, [route]);

  useEffect(() => {
    if (route.kind !== "site") {
      setSiteState({ status: "idle" });
      setPageState({ status: "idle" });
      return;
    }
    const ac = new AbortController();
    setSiteState({ status: "loading" });
    setPageState({ status: "idle" });
    fetchPublicSite(route.orgSlug, route.projectSlug, route.version, ac.signal)
      .then((data) => setSiteState({ status: "ok", data }))
      .catch((error: unknown) => {
        if (!ac.signal.aborted) {
          setSiteState({ status: "error", error });
        }
      });
    return () => ac.abort();
  }, [route]);

  useEffect(() => {
    if (route.kind !== "site" || siteState.status !== "ok") {
      return;
    }
    const ac = new AbortController();
    const path = resolvePagePath(siteState.data.nav, route.pagePath);
    setPageState({ status: "loading" });
    fetchPublicPage(route.orgSlug, route.projectSlug, route.version, path, ac.signal)
      .then((data) => setPageState({ status: "ok", data }))
      .catch((error: unknown) => {
        if (!ac.signal.aborted) {
          setPageState({ status: "error", error });
        }
      });
    return () => ac.abort();
  }, [route, siteState]);

  useEffect(() => {
    if (route.kind !== "site") {
      document.title = "LoreLink Docs";
      return;
    }
    const pageTitle = page?.doc.title;
    const siteTitle = site?.title || site?.project.name || route.projectSlug;
    document.title = pageTitle ? `${pageTitle} · ${siteTitle}` : siteTitle;
  }, [route, page, site]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (route.kind !== "site" || !site) {
          return;
        }
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.kind, site]);

  useEffect(() => {
    const headings = page?.doc.headings ?? [];
    if (headings.length === 0) {
      setActiveHeading("");
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) {
          setActiveHeading(visible[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -55% 0px", threshold: [0, 1] },
    );
    for (const heading of headings) {
      const el = heading.id ? document.getElementById(heading.id) : null;
      if (el) {
        observer.observe(el);
      }
    }
    return () => observer.disconnect();
  }, [page]);

  useEffect(() => {
    if (pageState.status !== "ok") {
      return;
    }
    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      document.getElementById(decodeURIComponent(hash))?.scrollIntoView();
      return;
    }
    window.scrollTo(0, 0);
  }, [pageState.status, page?.path]);

  function closeNav() {
    setNavOpen(false);
  }

  function go(href: string) {
    closeNav();
    setSearchOpen(false);
    navigateTo(href);
  }

  function onAppLink(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const href = event.currentTarget.getAttribute("href");
    if (!href || !href.startsWith("/view/")) {
      return;
    }
    event.preventDefault();
    go(href);
  }

  function onArticleClick(event: MouseEvent<HTMLElement>) {
    const target = (event.target as HTMLElement | null)?.closest("a");
    if (!target || route.kind !== "site") {
      return;
    }
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const href = target.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("http://") || href.startsWith("https://")) {
      return;
    }
    if (href.startsWith("/view/")) {
      event.preventDefault();
      go(href);
      return;
    }
    if (href.startsWith("/")) {
      return;
    }
    const relative = href.replace(/^\.\//, "").split("#")[0] ?? "";
    const resolved = resolvePagePath(nav, relative);
    const matched = nav.find((item) => item.path === resolved);
    event.preventDefault();
    go(viewHref(route.orgSlug, route.projectSlug, route.version, matched?.slug ?? relative.replace(/\.md$/i, "")));
  }

  const projectLabel = site?.project.name || site?.title || (route.kind === "site" ? route.projectSlug : "Documentation");
  const orgLabel = site?.project.org || (route.kind === "site" ? route.orgSlug : "");

  const sidebar = (
    <>
      <div className="border-b border-border px-5 py-5">
        <a className="inline-flex items-center gap-2.5" href={route.kind === "site" ? viewHref(route.orgSlug, route.projectSlug, version) : "/view/"} onClick={onAppLink}>
          <img src="/view/logo.png" alt="" width={36} height={36} className="size-9 object-contain" aria-hidden="true" />
          <span className="brand-mark text-xl leading-none">LoreLink</span>
        </a>
        {route.kind === "site" ? (
          <p className="mt-3 truncate text-sm text-muted-foreground" title={projectLabel}>
            {projectLabel}
          </p>
        ) : null}
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Contents">
        <p className="nav-title">Contents</p>
        {route.kind !== "site" ? <p className="px-2 text-sm text-muted-foreground">Open a published site from the portal</p> : null}
        {route.kind === "site" && siteState.status === "loading" ? (
          <div className="grid gap-2 px-2" aria-busy="true" aria-label="Loading contents">
            <div className="h-8 animate-pulse rounded bg-muted" />
            <div className="h-8 animate-pulse rounded bg-muted" />
            <div className="h-8 animate-pulse rounded bg-muted" />
          </div>
        ) : null}
        {route.kind === "site" && site && nav.length === 0 ? <p className="px-2 text-sm text-muted-foreground">No pages published</p> : null}
        {nav.map((item) => {
          const href = route.kind === "site" ? viewHref(route.orgSlug, route.projectSlug, version, item.slug) : "/view/";
          const active = isActiveNav(item, currentSlug, page?.path ?? "");
          return (
            <a
              key={`${item.path}:${item.slug}`}
              href={href}
              className={active ? "nav-link nav-link-active" : "nav-link"}
              aria-current={active ? "page" : undefined}
              onClick={onAppLink}
            >
              {item.title || item.slug || "Untitled"}
            </a>
          );
        })}
      </nav>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[var(--sidebar-w)_1fr]">
      <aside className="hidden min-h-screen flex-col border-r border-border bg-sidebar lg:flex">{sidebar}</aside>
      {navOpen ? (
        <div className="lg:hidden">
          <button type="button" className="overlay" aria-label="Close documentation navigation" onClick={closeNav} />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-sidebar">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="btn btn-ghost btn-square lg:hidden" aria-label="Open documentation navigation" onClick={() => setNavOpen(true)}>
              <IconMenu />
            </button>
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Documentation</p>
              <p className="truncate text-sm font-medium">{route.kind === "directory" ? "Published sites" : projectLabel}</p>
            </div>
          </div>
          <div className="hidden max-w-md flex-1 md:flex">
            <button
              type="button"
              className="search-chip w-full text-left disabled:opacity-60"
              disabled={route.kind !== "site" || !site}
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen(true)}
            >
              {isMac ? <kbd className="kbd">⌘</kbd> : <kbd className="kbd">Ctrl</kbd>}
              <kbd className="kbd">K</kbd>
              <span>{site ? "Search this documentation" : "Search is unavailable until a project is opened"}</span>
            </button>
          </div>
          <div className="flex items-center gap-2">
            {route.kind === "site" && site ? (
              <button type="button" className="btn btn-ghost btn-square md:hidden" aria-label="Search documentation" onClick={() => setSearchOpen(true)}>
                <IconSearch />
              </button>
            ) : null}
            <select
              className="select max-w-28 sm:max-w-40"
              aria-label="Version"
              disabled={route.kind !== "site" || !site}
              value={site ? version : ""}
              onChange={(event) => {
                if (route.kind !== "site") {
                  return;
                }
                go(viewHref(route.orgSlug, route.projectSlug, event.target.value, currentSlug));
              }}
            >
              {site ? (
                versionOptions.map((name) => (
                  <option key={name} value={name}>
                    {versionLabel(site, name)}
                  </option>
                ))
              ) : (
                <option value="">No version</option>
              )}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-square"
              aria-label={theme === DARK_THEME ? "Switch to light theme" : "Switch to dark theme"}
              onClick={() => setTheme(toggleTheme(theme))}
            >
              {theme === DARK_THEME ? <IconSun /> : <IconMoon />}
            </button>
          </div>
        </header>

        <div className="flex flex-1">
          <article className="docs-prose mx-auto w-full px-5 py-12 lg:px-12" onClick={onArticleClick}>
            {route.kind === "directory" ? <DirectoryEmpty /> : null}
            {route.kind === "site" ? (
              <SiteArticle
                orgLabel={orgLabel}
                projectLabel={projectLabel}
                siteState={siteState}
                pageState={pageState}
                siteError={siteError}
                pageError={pageError}
                doc={page?.doc}
                prev={prev}
                next={next}
                hrefFor={(item) => viewHref(route.orgSlug, route.projectSlug, version, item.slug)}
                onAppLink={onAppLink}
              />
            ) : null}
          </article>
          <aside className="hidden w-[var(--toc-w)] shrink-0 border-l border-border p-6 xl:block">
            <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">On this page</p>
            {page?.doc.headings.length ? (
              <nav className="mt-3 grid gap-1" aria-label="On this page">
                {page.doc.headings.map((heading) => (
                  <a
                    key={heading.id || heading.text}
                    href={`#${heading.id}`}
                    className={`block rounded-sm px-2 py-1 text-sm ${
                      heading.id && heading.id === activeHeading ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"
                    }`}
                    style={{ paddingLeft: `${Math.max(heading.level - 1, 0) * 0.65 + 0.5}rem` }}
                  >
                    {heading.text}
                  </a>
                ))}
              </nav>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No headings yet</p>
            )}
          </aside>
        </div>

        <footer className="flex flex-col gap-6 border-t border-border bg-sidebar px-6 py-8 text-sm sm:flex-row sm:justify-between">
          <div>
            <p className="brand-mark text-xl">LoreLink</p>
            <p className="mt-1 text-muted-foreground">Your projects. Their lore. All connected.</p>
          </div>
          <nav>
            <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Site</p>
            <a className="mt-2 inline-block underline-offset-4 hover:underline" href="/">
              Management portal
            </a>
          </nav>
        </footer>
      </div>

      {searchOpen && route.kind === "site" && site ? (
        <SearchModal
          orgSlug={route.orgSlug}
          projectSlug={route.projectSlug}
          version={version}
          nav={nav}
          onClose={() => setSearchOpen(false)}
          onNavigate={(slug) => go(viewHref(route.orgSlug, route.projectSlug, version, slug))}
        />
      ) : null}
    </div>
  );
}

function DirectoryEmpty() {
  return (
    <div>
      <h1 className="docs-heading text-3xl">Documentation</h1>
      <p className="mt-4 text-muted-foreground">Open a published site from the portal</p>
      <a className="btn btn-primary mt-6" href="/">
        Management portal
      </a>
    </div>
  );
}

function SiteArticle({
  orgLabel,
  projectLabel,
  siteState,
  pageState,
  siteError,
  pageError,
  doc,
  prev,
  next,
  hrefFor,
  onAppLink,
}: {
  orgLabel: string;
  projectLabel: string;
  siteState: LoadState<PublicSite>;
  pageState: LoadState<PublicPage>;
  siteError: unknown;
  pageError: unknown;
  doc?: PublicDoc;
  prev?: NavItem;
  next?: NavItem;
  hrefFor: (item: NavItem) => string;
  onAppLink: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (siteState.status === "error") {
    return <StatusPanel error={siteError} />;
  }
  if (siteState.status === "loading") {
    return <ArticleSkeleton />;
  }
  if (pageState.status === "error") {
    return <StatusPanel error={pageError} />;
  }
  if (pageState.status === "loading" || pageState.status === "idle") {
    return <ArticleSkeleton />;
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {orgLabel} / {projectLabel}
      </p>
      {doc?.title && !htmlStartsWithHeading(doc.html) ? <h1 className="docs-heading mt-4 text-4xl sm:text-5xl">{doc.title}</h1> : null}
      {doc?.description ? <p className="mt-5 text-muted-foreground">{doc.description}</p> : null}
      {doc?.html ? <div className={doc.title || doc.description ? "mt-8" : "mt-4"} dangerouslySetInnerHTML={{ __html: doc.html }} /> : null}
      {!doc?.html && !doc?.title ? <p className="text-muted-foreground">This page has no published content.</p> : null}
      <div className="mt-12 flex justify-between gap-6 border-t border-border pt-6 text-sm">
        {prev ? (
          <a href={hrefFor(prev)} className="min-w-0 hover:underline" onClick={onAppLink}>
            <span className="block text-muted-foreground">Previous</span>
            <span className="font-medium">{prev.title}</span>
          </a>
        ) : (
          <span className="text-muted-foreground">Previous</span>
        )}
        {next ? (
          <a href={hrefFor(next)} className="min-w-0 text-right hover:underline" onClick={onAppLink}>
            <span className="block text-muted-foreground">Next</span>
            <span className="font-medium">{next.title}</span>
          </a>
        ) : (
          <span className="text-muted-foreground">Next</span>
        )}
      </div>
    </>
  );
}

function StatusPanel({ error }: { error: unknown }) {
  if (isPublicApiError(error) && error.needsSignIn) {
    return (
      <div>
        <h1 className="docs-heading text-4xl">Sign in required</h1>
        <p className="mt-5 text-muted-foreground">{error.message || "This documentation is not public."}</p>
        <a className="btn btn-primary mt-6" href="/">
          Sign in
        </a>
      </div>
    );
  }
  if (isPublicApiError(error) && error.notFound) {
    return (
      <div>
        <h1 className="docs-heading text-4xl">Page not found</h1>
        <p className="mt-5 text-muted-foreground">This page is not published for the selected version.</p>
      </div>
    );
  }
  return (
    <div>
      <h1 className="docs-heading text-4xl">Unable to load documentation</h1>
      <div role="alert" className="alert alert-error mt-6">
        {isPublicApiError(error) ? error.message : "The documentation service could not be reached."}
      </div>
    </div>
  );
}

function ArticleSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="mt-5 h-12 w-3/4 animate-pulse rounded bg-muted" />
      <div className="mt-8 h-4 w-full animate-pulse rounded bg-muted" />
      <div className="mt-3 h-4 w-11/12 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-4 w-10/12 animate-pulse rounded bg-muted" />
    </div>
  );
}

function currentNavIndex(nav: NavItem[], pagePath: string, filePath: string): number {
  return nav.findIndex((item) => isActiveNav(item, pagePath, filePath));
}

function isActiveNav(item: NavItem, pagePath: string, filePath: string): boolean {
  if (!pagePath) {
    return item.slug === "" || /(?:^|\/)index\.md$/i.test(item.path) || item.path === filePath;
  }
  return item.slug === pagePath || item.path === pagePath || item.path === filePath || item.path.replace(/\.md$/i, "") === pagePath;
}

function versionChoices(site: PublicSite | null, current: string): string[] {
  const names = ["latest", ...(site?.versions.map((item) => item.name) ?? []), current].filter(Boolean);
  return [...new Set(names)];
}

function htmlStartsWithHeading(html: string): boolean {
  return /^<h[1-6][\s>]/i.test(html.trim());
}

function versionLabel(site: PublicSite | null, name: string): string {
  const match = site?.versions.find((item) => item.name === name);
  if (match?.alias && match.alias !== name) {
    return `${name} (${match.alias})`;
  }
  return name;
}

function IconMenu() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M17 7l1.4-1.4M5.6 18.4l1.4-1.4" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
