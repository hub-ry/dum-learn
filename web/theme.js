// Light/dark theme for the whole site (files, learn, time, /explore/).
// Classic script loaded in <head> so the page never flashes the wrong theme.
// Default follows prefers-color-scheme; a choice made with T or the theme
// button is remembered in localStorage ("learn.theme").
(() => {
  const KEY = "learn.theme";
  const mq = matchMedia("(prefers-color-scheme: light)");
  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  function apply() {
    const t = stored() === "light" || stored() === "dark" ? stored() : mq.matches ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    document.dispatchEvent(new CustomEvent("learn:theme", { detail: t }));
  }
  apply();
  mq.addEventListener?.("change", () => { if (!stored()) apply(); });
  addEventListener("storage", (e) => { if (e.key === KEY) apply(); });
  window.learnTheme = {
    get: () => document.documentElement.dataset.theme,
    toggle() {
      try { localStorage.setItem(KEY, this.get() === "light" ? "dark" : "light"); } catch {}
      apply();
    },
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "T" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    window.learnTheme.toggle();
  });
  document.addEventListener("click", (e) => { if (e.target.closest?.("[data-theme-toggle]")) window.learnTheme.toggle(); });
})();
