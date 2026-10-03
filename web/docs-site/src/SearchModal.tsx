import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fetchPublicSearch, isPublicApiError, matchNavItem, resolvePageSlug } from "./api";
import { pageSlugFromPath } from "./routing";
import type { NavItem, SearchResult } from "./types";

type SearchModalProps = {
  orgSlug: string;
  projectSlug: string;
  version: string;
  nav: NavItem[];
  onClose: () => void;
  onNavigate: (slug: string) => void;
};

export function SearchModal({ orgSlug, projectSlug, version, nav, onClose, onNavigate }: SearchModalProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      setStatus("idle");
      setError("");
      return;
    }
    const ac = new AbortController();
    setStatus("loading");
    setResults([]);
    setError("");
    fetchPublicSearch(orgSlug, projectSlug, version, debounced, ac.signal)
      .then((payload) => {
        setResults(payload.results);
        setActive(0);
        setStatus("ok");
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) {
          return;
        }
        setResults([]);
        setStatus("error");
        setError(isPublicApiError(err) ? err.message : "Search failed");
      });
    return () => ac.abort();
  }, [debounced, orgSlug, projectSlug, version]);

  const items = useMemo(
    () =>
      results.map((result) => {
        const slug = resolvePageSlug(nav, result.path) || pageSlugFromPath(result.path);
        const matched = matchNavItem(nav, result.path);
        return {
          ...result,
          slug,
          label: result.title || matched?.title || slug || result.path,
          snippet: snippet(result.body || result.headings, debounced),
        };
      }),
    [results, nav, debounced],
  );

  function choose(index: number) {
    const item = items[index];
    if (!item) {
      return;
    }
    onNavigate(item.slug);
    onClose();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => Math.min(value + 1, Math.max(items.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(value - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  }

  return (
    <div className="modal-layer" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        className="modal-panel max-w-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="font-serif text-xl font-semibold tracking-tight">
              Search documentation
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Find pages by title or body text.</p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="field mt-5">
          <span className="field-label">Query</span>
          <input
            ref={inputRef}
            className="input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this version"
            autoComplete="off"
            aria-autocomplete="list"
            aria-controls="docs-search-results"
          />
        </label>
        <div id="docs-search-results" className="mt-4 max-h-80 overflow-y-auto" role="listbox" aria-label="Search results">
          {status === "loading" ? <p className="px-1 py-3 text-sm text-muted-foreground">Searching…</p> : null}
          {status === "error" ? (
            <div role="alert" className="alert alert-error">
              {error}
            </div>
          ) : null}
          {status === "ok" && items.length === 0 ? <p className="px-1 py-3 text-sm text-muted-foreground">No matching pages</p> : null}
          {status === "idle" ? <p className="px-1 py-3 text-sm text-muted-foreground">Type to search the published pages.</p> : null}
          {items.map((item, index) => (
            <button
              key={`${item.path}-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`block w-full rounded-[var(--radius)] px-3 py-2.5 text-left ${
                index === active ? "bg-muted" : "hover:bg-muted"
              }`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span className="block font-medium">{item.label}</span>
              {item.snippet ? <span className="mt-0.5 block text-sm text-muted-foreground">{item.snippet}</span> : null}
              <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{item.path || item.slug}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function snippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  const lower = compact.toLowerCase();
  const needle = query.toLowerCase();
  const index = needle ? lower.indexOf(needle) : 0;
  const start = index >= 0 ? Math.max(0, index - 48) : 0;
  const excerpt = compact.slice(start, start + 160);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + 160 < compact.length ? "…" : "";
  return `${prefix}${excerpt}${suffix}`;
}
