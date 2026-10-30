import { useState } from "react";
import { type Lang, say } from "./words";

// His theme: the system's (auto) unless he picked light or dark, kept in this browser only.

const THEMES = [
  ["auto", "Auto", "Auto"],
  ["light", "Clair", "Light"],
  ["dark", "Sombre", "Dark"],
] as const;
type Choice = (typeof THEMES)[number][0];

export function readTheme(): Choice {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(theme: Choice) {
  if (theme === "auto") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export function Theme({ lang }: { lang: Lang }) {
  const [theme, setTheme] = useState(readTheme);
  return (
    <fieldset className="m-0 flex items-baseline gap-3.5 border-0 px-3 pt-4 text-[14px] text-muted">
      <legend className="float-left pr-0.5">
        {say(lang, "Thème", "Theme")}
      </legend>
      {THEMES.map(([id, fr, en]) => (
        <button
          aria-pressed={theme === id}
          className="link aria-pressed:font-bold aria-pressed:text-ink aria-pressed:no-underline"
          key={id}
          onClick={() => {
            try {
              localStorage.setItem("theme", id);
            } catch {
              // Private browsing: the pick lasts this visit.
            }
            applyTheme(id);
            setTheme(id);
          }}
          type="button"
        >
          {say(lang, fr, en)}
        </button>
      ))}
    </fieldset>
  );
}
