// Design tokens for canvas code: read once from the stylesheet (styles.css :root), with fallbacks so the
// pure modules still work under node. Owner: C.
const FALLBACK = {
  "--ink-1": "#EDEDEE", "--ink-2": "#B4B4B8", "--ink-3": "#8A8A90", "--line-1": "#2A2A2D", "--line-2": "#3C3C41",
  "--line-3": "#6E6E76", "--bg-1": "#131314", "--bg-2": "#1B1B1D",
};
let cache = null;
export function tok(name) {
  if (!cache) {
    cache = { ...FALLBACK };
    if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
      const cs = getComputedStyle(document.documentElement);
      for (const k of Object.keys(FALLBACK)) { const v = cs.getPropertyValue(k).trim(); if (v) cache[k] = v; }
    }
  }
  return cache[name] || FALLBACK[name] || "#888";
}
/** "#RRGGBB" + alpha -> rgba(). */
export function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
