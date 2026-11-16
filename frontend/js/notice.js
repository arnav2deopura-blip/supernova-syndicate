// One error / empty-state component for every mode: what happened -> why -> what to do. Owner: C.
//   showNotice(el, { tone: "error"|"empty"|"warn"|"info", title, why, actions: [{label, onClick, primary}] })
//   clearNotice(el)

import { iconEl } from "./icons.js";

const ICON = { error: "alert", empty: "info", warn: "alert", info: "info" };

export function showNotice(el, { tone = "info", title, why = "", actions = [] }) {
  el.hidden = false;
  el.className = `notice notice-${tone}`;
  el.setAttribute("role", tone === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "notice-icon"; icon.setAttribute("aria-hidden", "true"); icon.append(iconEl(ICON[tone] || "info"));
  const body = document.createElement("div");
  body.className = "notice-body";
  const t = document.createElement("strong"); t.textContent = title;
  body.append(t);
  if (why) { const p = document.createElement("p"); p.textContent = why; body.append(p); }
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "notice-actions";
    for (const a of actions) {
      const b = document.createElement(a.href ? "a" : "button");
      if (a.href) { b.href = a.href; b.target = "_blank"; b.rel = "noopener"; b.className = "btn"; }
      else { b.type = "button"; if (a.primary) b.className = "primary"; b.addEventListener("click", a.onClick); }
      b.textContent = a.label;
      row.append(b);
    }
    body.append(row);
  }
  el.replaceChildren(icon, body);
}

export function clearNotice(el) { el.hidden = true; el.replaceChildren(); }

/** Plain-language messages for the situations every mode can hit (docs/IMPROVEMENT_PLAN.md §5). */
export const NOTICES = {
  noCoverage: (band) => ({
    tone: "empty", title: `SPHEREx hasn't imaged this spot in ${band} yet.`,
    why: "The survey is still filling in the sky, one pass every ~6 months. Another band may already have data here.",
  }),
  onePass: (label) => ({
    tone: "empty", title: "Only one pass so far — nothing to compare yet.",
    why: `SPHEREx has looked here once (${label}). It revisits every part of the sky about every 6 months, so a second pass will make changes visible.`,
  }),
  saturated: (band) => ({
    tone: "warn", title: "Too bright: the target's core is saturated (OVERFLOW).",
    why: `In ${band} the centre of this star overflows the detector, so its brightness and position there are less precise and its leftovers can look like changes. A redder band (higher D number) is often not saturated.`,
  }),
  backendDown: (msg, verify = false) => ({
    tone: "error", title: "The SPHEREx backend could not be reached.",
    why: verify
      ? `${msg ? `(${msg}) ` : ""}Verify mode (?verify=1) never shows saved data, so there is no image. Retry, or remove ?verify=1 to allow saved test-target data.`
      : `${msg ? `(${msg}) ` : ""}Precomputed data exists only for the five test targets. Try again in a moment, or pick a test target.`,
  }),
  badResponse: (msg) => ({
    tone: "error", title: "The service returned data this page cannot read.",
    why: `${msg ? `(${msg}) ` : ""}Nothing is drawn from it. This is usually a server-side fault or a version mismatch; retrying can help.`,
  }),
  stalled: () => ({
    tone: "warn", title: "No progress for 2 minutes.",
    why: "The server has not reported any progress on this request. It may still be downloading a large set of files, or it may be stuck.",
  }),
  noNoise: () => ({
    tone: "empty", title: "Noise maps aren't available for this view.",
    why: "The σ view needs a noise map for each pass. Channel ranges and older bakes don't have them. Use the whole detector band instead, or the plain Difference view.",
  }),
};
