// Skippable guided tour: anchored coach marks over a dimmed page. No library. Owner: C.
// Skip / ✕ on every step, Esc closes, ←/→ step. "Don't show again" lives in localStorage (try/catch).
// The "?" button in the header restarts it; ?tour=1 deep-links to it.

import { icon } from "./icons.js";

const KEY = "sse.tourDone";
export const tourDone = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const setDone = (v) => { try { v ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch { /* storage blocked */ } };

let root = null, current = -1, steps = [], lastFocus = null;

function build() {
  root = document.createElement("div");
  root.className = "tour";
  root.innerHTML = `
    <div class="tour-spot" aria-hidden="true"></div>
    <div class="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tour-title" tabindex="-1">
      <button type="button" class="tour-x" aria-label="Close the tour">${icon("x")}</button>
      <p class="tour-count"></p>
      <h3 id="tour-title"></h3>
      <div class="tour-text"></div>
      <label class="tour-never"><input type="checkbox"> Don't show again</label>
      <div class="tour-nav">
        <button type="button" class="tour-skip">Skip tour</button>
        <span class="grow"></span>
        <button type="button" class="tour-back">Back</button>
        <button type="button" class="tour-next primary">Next</button>
      </div>
    </div>`;
  document.body.append(root);
  root.querySelector(".tour-x").addEventListener("click", () => end());
  root.querySelector(".tour-skip").addEventListener("click", () => end());
  root.querySelector(".tour-back").addEventListener("click", () => go(current - 1));
  root.querySelector(".tour-next").addEventListener("click", () => (current >= steps.length - 1 ? end(true) : go(current + 1)));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); end(); }
    else if (e.key === "ArrowRight") go(Math.min(steps.length - 1, current + 1));
    else if (e.key === "ArrowLeft") go(Math.max(0, current - 1));
    else if (e.key === "Tab") {   // keep focus in the popover
      const f = [...root.querySelectorAll(".tour-pop button, .tour-pop input")];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  });
  addEventListener("resize", () => current >= 0 && place());
  addEventListener("scroll", () => current >= 0 && place(), { passive: true });
}

function target() {
  const s = steps[current];
  const el = s.el && (typeof s.el === "function" ? s.el() : document.querySelector(s.el));
  return el && el.offsetParent !== null ? el : null;
}

function place() {
  const spot = root.querySelector(".tour-spot"), pop = root.querySelector(".tour-pop");
  const el = target();
  const pad = 6;
  if (!el) {
    spot.style.cssText = `left:50%;top:40%;width:0;height:0`;
    pop.style.left = `${Math.max(12, (innerWidth - pop.offsetWidth) / 2)}px`;
    pop.style.top = `${Math.max(12, innerHeight * 0.3)}px`;
    return;
  }
  const r = el.getBoundingClientRect();
  spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px`;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let top = r.bottom + 12;
  if (top + ph > innerHeight - 12) top = r.top - ph - 12;           // above
  if (top < 12) top = Math.min(innerHeight - ph - 12, Math.max(12, r.top + 12));   // overlap, inside
  const left = Math.min(innerWidth - pw - 12, Math.max(12, r.left + r.width / 2 - pw / 2));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

async function go(i) {
  if (i < 0 || i >= steps.length) return;
  current = i;
  const s = steps[i];
  try { await s.before?.(); } catch (e) { console.warn("tour step setup failed", e); }
  if (current !== i) return;
  const el = target();
  el?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  root.querySelector(".tour-count").textContent = `Step ${i + 1} of ${steps.length}`;
  root.querySelector("#tour-title").textContent = s.title;
  const text = root.querySelector(".tour-text");
  text.replaceChildren(...[].concat(s.text).map((t) => { const p = document.createElement("p"); p.innerHTML = t; return p; }));
  root.querySelector(".tour-back").disabled = i === 0;
  root.querySelector(".tour-next").textContent = i === steps.length - 1 ? "Finish" : "Next";
  place();
  requestAnimationFrame(place);
  setTimeout(place, 400);   // after smooth scrolling settles
  root.querySelector(".tour-pop").focus({ preventScroll: true });
}

/** steps: [{el: selector|fn, title, text: html string|array, before: async fn}] */
export function startTour(list) {
  if (!root) build();
  steps = list;
  lastFocus = document.activeElement;
  root.hidden = false;
  root.querySelector(".tour-never input").checked = tourDone();
  document.body.classList.add("touring");
  go(0);
}

function end(finished = false) {
  if (!root || root.hidden) return;
  const never = root.querySelector(".tour-never input").checked;
  setDone(never || finished);
  root.hidden = true;
  current = -1;
  document.body.classList.remove("touring");
  lastFocus?.focus?.();
}
