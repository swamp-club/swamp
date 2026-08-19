import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const THEME_KEY = "swamp-dashboard-theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme) ?? "system",
  );

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const buttons: { t: Theme; label: string }[] = [
    { t: "light", label: "☀" },
    { t: "system", label: "▨" },
    { t: "dark", label: "☾" },
  ];

  return (
    <div
      style={{
        display: "flex",
        background: "rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 2,
        margin: "0 8px 16px",
      }}
    >
      {buttons.map(({ t, label }) => (
        <button
          type="button"
          key={t}
          onClick={() => setTheme(t)}
          title={t}
          style={{
            flex: 1,
            padding: "5px 0",
            border: "none",
            background: theme === t ? "rgba(255,255,255,0.1)" : "transparent",
            color: theme === t
              ? "var(--sidebar-text-active)"
              : "var(--sidebar-text)",
            cursor: "pointer",
            borderRadius: 4,
            fontSize: "0.85rem",
            lineHeight: 1,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
