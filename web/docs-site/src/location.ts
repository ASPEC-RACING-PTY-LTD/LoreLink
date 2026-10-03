import { useSyncExternalStore } from "react";

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

function getPathname(): string {
  return window.location.pathname;
}

function getServerPathname(): string {
  return "/view/";
}

// Subscribe to the browser history API.
// Source: https://react.dev/reference/react/useSyncExternalStore#subscribing-to-a-browser-api
export function usePathname(): string {
  return useSyncExternalStore(subscribe, getPathname, getServerPathname);
}

export function navigateTo(href: string, replace = false): void {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current === href) {
    return;
  }
  if (replace) {
    window.history.replaceState({}, "", href);
  } else {
    window.history.pushState({}, "", href);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}
