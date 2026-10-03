export const LIGHT_THEME = "lorelink" as const;
export const DARK_THEME = "lorelink-dark" as const;
export const THEME_KEY = "lorelink-theme";

export type LoreLinkTheme = typeof LIGHT_THEME | typeof DARK_THEME;

export function applyTheme(theme: LoreLinkTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.classList.toggle("dark", theme === DARK_THEME);
  localStorage.setItem(THEME_KEY, theme);
}

export function initTheme(): LoreLinkTheme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === LIGHT_THEME || stored === DARK_THEME) {
    applyTheme(stored);
    return stored;
  }
  const theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_THEME : LIGHT_THEME;
  applyTheme(theme);
  return theme;
}

export function toggleTheme(current: LoreLinkTheme): LoreLinkTheme {
  const next = current === LIGHT_THEME ? DARK_THEME : LIGHT_THEME;
  applyTheme(next);
  return next;
}
