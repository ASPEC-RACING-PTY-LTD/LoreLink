import { DARK_THEME, initTheme, toggleTheme, type LoreLinkTheme } from "@lorelink/shared/theme";
import { useState } from "react";

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

export function DocsShell() {
  const [theme, setTheme] = useState<LoreLinkTheme>(() => initTheme());
  const [navOpen, setNavOpen] = useState(false);

  const sidebar = (
    <>
      <div className="border-b border-border px-5 py-5">
        <span className="inline-flex items-center gap-2.5">
          <img src="/view/logo.png" alt="" width={36} height={36} className="size-9 object-contain" aria-hidden="true" />
          <span className="brand-mark text-xl leading-none">LoreLink</span>
        </span>
      </div>
      <nav className="px-3 py-4" aria-label="Contents">
        <p className="nav-title">Contents</p>
        <p className="px-2 text-sm text-muted-foreground">No pages published</p>
      </nav>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[var(--sidebar-w)_1fr]">
      <aside className="hidden min-h-screen flex-col border-r border-border bg-sidebar lg:flex">{sidebar}</aside>
      {navOpen ? (
        <div className="lg:hidden">
          <button type="button" className="overlay" aria-label="Close documentation navigation" onClick={() => setNavOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-sidebar">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn btn-ghost btn-square lg:hidden"
              aria-label="Open documentation navigation"
              onClick={() => setNavOpen(true)}
            >
              <IconMenu />
            </button>
            <div>
              <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Documentation</p>
              <p className="text-sm font-medium">Unpublished site</p>
            </div>
          </div>
          <div className="hidden max-w-md flex-1 md:flex">
            <div className="search-chip w-full">
              <kbd className="kbd">Ctrl</kbd>
              <kbd className="kbd">K</kbd>
              <span>Search is unavailable until a project is published</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select className="select hidden sm:block" disabled aria-label="Version">
              <option>No version</option>
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
          <article className="docs-prose mx-auto w-full px-5 py-12 lg:px-12">
            <p className="text-sm text-muted-foreground">Docs / Unpublished</p>
            <h1 className="docs-heading mt-4 text-4xl sm:text-5xl">No published documentation yet</h1>
            <p className="mt-5 text-muted-foreground">
              This is the public reading shell. Navigation, search, and the page renderer land in a later phase. The
              chrome and typography are the ones every published site will inherit.
            </p>
            <div role="alert" className="alert alert-info mt-8">
              Hosted documentation will appear here after a project is published.
            </div>
            <div className="mt-12 flex justify-between border-t border-border pt-6 text-sm text-muted-foreground">
              <span>Previous</span>
              <span>Next</span>
            </div>
          </article>
          <aside className="hidden w-[var(--toc-w)] shrink-0 border-l border-border p-6 xl:block">
            <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">On this page</p>
            <p className="mt-3 text-sm text-muted-foreground">No headings yet</p>
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
    </div>
  );
}
