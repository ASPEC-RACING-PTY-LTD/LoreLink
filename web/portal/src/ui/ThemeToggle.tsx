import { DARK_THEME, toggleTheme, type LoreLinkTheme } from "@lorelink/shared/theme";
import { IconMoon, IconSun } from "./icons";

export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: LoreLinkTheme;
  onChange: (next: LoreLinkTheme) => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-square"
      aria-label={theme === DARK_THEME ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => onChange(toggleTheme(theme))}
    >
      {theme === DARK_THEME ? <IconSun /> : <IconMoon />}
    </button>
  );
}
