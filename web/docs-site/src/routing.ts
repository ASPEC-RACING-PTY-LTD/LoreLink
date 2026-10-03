export const VIEW_BASE = "/view";

export type ViewRoute =
  | { kind: "directory" }
  | {
      kind: "site";
      orgSlug: string;
      projectSlug: string;
      version: string;
      pagePath: string;
    };

export function parseViewPath(pathname: string): ViewRoute {
  const raw = pathname.split(/[?#]/, 1)[0] ?? "";
  let rest = raw;
  if (rest === VIEW_BASE || rest === `${VIEW_BASE}/`) {
    return { kind: "directory" };
  }
  if (rest.startsWith(`${VIEW_BASE}/`)) {
    rest = rest.slice(VIEW_BASE.length + 1);
  } else {
    rest = rest.replace(/^\/+/, "");
  }
  rest = rest.replace(/\/+$/, "");
  if (!rest) {
    return { kind: "directory" };
  }

  const parts = rest.split("/").map(safeDecode).filter(Boolean);
  if (parts.length < 2) {
    return { kind: "directory" };
  }

  const [orgSlug, projectSlug, versionPart, ...pageParts] = parts;
  return {
    kind: "site",
    orgSlug,
    projectSlug,
    version: versionPart || "latest",
    pagePath: pageParts.join("/"),
  };
}

export function viewHref(orgSlug: string, projectSlug: string, version: string, slug = "", hash = ""): string {
  const segments = [VIEW_BASE, orgSlug, projectSlug, version || "latest"];
  for (const part of slug.split("/")) {
    if (part) {
      segments.push(part);
    }
  }
  const path = segments.map(encodeURIComponent).join("/");
  if (!hash) {
    return path;
  }
  return hash.startsWith("#") ? `${path}${hash}` : `${path}#${hash}`;
}

export function pageSlugFromPath(rel: string): string {
  let value = rel.replace(/\\/g, "/").replace(/\.md$/i, "");
  value = value.replace(/\/index$/i, "");
  if (value === "index" || value === "") {
    return "";
  }
  return value.replace(/^\/+/, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
