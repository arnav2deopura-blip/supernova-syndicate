// Skins: visual controls that sit on top of the native ones. They only set the value of the existing input and
// fire its normal event; they never call the API or read app state. If this module fails, the native
// <select>s underneath still work (they are shown unless <body> has the js-skins class). Owner: C.
import { DETECTORS, MOLECULES, N_CH, channelAt, detectorFor } from "./bands.js";

const fire = (el, type = "change") => el.dispatchEvent(new Event(type, { bubbles: true }));
const make = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter(Boolean));
  return e;
};

/** Field-of-view segmented control mirroring every <option> of the select (including a drawn size). */
export function fovSkin(select, box) {
  const render = () => {
    box.replaceChildren(...[...select.options].map((o) => {
      const on = o.value === select.value;
      const b = make("button", { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1",
        title: o.dataset.custom != null ? "Drawn on the sky map" : `${o.value}° field of view`, text: o.dataset.custom != null ? `${o.value}°*` : o.text });
      b.addEventListener("click", () => { if (select.value !== o.value) { select.value = o.value; fire(select); } render(); });
      return b;
    }));
  };
  box.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const btns = [...box.querySelectorAll("button")];
    const i = btns.indexOf(document.activeElement);
    btns[(i + d + btns.length) % btns.length]?.focus();
  });
  select.addEventListener("change", render);
  new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true });
  render();
  box.hidden = false;
  return { render };
}

/**
 * Wavelength ruler: six equal-width detector segments (D1–D6, 17 channel ticks each). Not to scale.
 *   click a segment            -> selects that detector (sets #band, fires change)
 *   drag inside the selected one -> proposes a channel range (sets #ch-lo/#ch-hi, calls onPropose) — the
 *                                   range box with its Apply button opens, because a range is an expensive request
 * update({band, range:{lo,hi}|null, gaps:Set(k)|null, det}) redraws the selection, range and coverage gaps.
 */
export function wavelengthSkin(bandSelect, box, { chLo, chHi, onPropose }) {
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", "Detector band. Equal-width segments: the wavelength axis is not to scale.");
  let view = { band: bandSelect.value, range: null, gaps: null, gapsDet: null };
  const segs = {};
  const kAt = (seg, clientX) => {
    const r = seg.getBoundingClientRect();
    return Math.min(N_CH, Math.max(1, Math.floor(((clientX - r.left) / r.width) * N_CH) + 1));
  };
  for (const [name, d] of Object.entries(DETECTORS)) {
    const ticks = make("span", { class: "wl-ticks", "aria-hidden": "true" }, ...Array.from({ length: N_CH }, () => make("i")));
    const mols = MOLECULES.filter((m) => detectorFor(m.lam) === name).map((m) => {
      const k = channelAt(name, m.lam);
      return make("span", { class: "wl-mol", style: `left:${((k - 0.5) / N_CH) * 100}%`, "aria-hidden": "true" });
    });
    const molText = MOLECULES.filter((m) => detectorFor(m.lam) === name).map((m) => `${m.label} ${m.lam} µm`).join(", ");
    const seg = make("button", {
      type: "button", class: "wl-seg", role: "radio", "aria-checked": "false", "data-det": name,
      title: `${name} · ${d.lo.toFixed(2)}–${d.hi.toFixed(2)} µm, 17 channels${molText ? `. Marks: ${molText}` : ""}. Drag inside the selected band to pick channels. Segments are equal width: the axis is not to scale.`,
      "aria-label": `${name}, ${d.lo.toFixed(2)} to ${d.hi.toFixed(2)} micrometres`,
    }, make("span", { class: "wl-name", text: name }), ...mols, ticks);
    let drag = null;
    seg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || seg.dataset.det !== bandSelect.value) return;
      drag = { k0: kAt(seg, e.clientX), k1: null, x0: e.clientX };
      seg.setPointerCapture?.(e.pointerId);
    });
    seg.addEventListener("pointermove", (e) => {
      if (!drag || Math.abs(e.clientX - drag.x0) < 4) return;
      drag.k1 = kAt(seg, e.clientX);
      paintProposal(seg, Math.min(drag.k0, drag.k1), Math.max(drag.k0, drag.k1));
    });
    const endDrag = (e) => {
      if (!drag) return;
      const d0 = drag; drag = null;
      if (d0.k1 == null) return;   // a click: handled below
      e.preventDefault();
      seg.dataset.dragged = "1";
      const lo = Math.min(d0.k0, d0.k1), hi = Math.max(d0.k0, d0.k1);
      chLo.value = lo; chHi.value = hi;
      fire(chLo, "input"); fire(chHi, "input");
      onPropose?.({ det: name, lo, hi });
    };
    seg.addEventListener("pointerup", endDrag);
    seg.addEventListener("pointercancel", () => { drag = null; paint(); });
    seg.addEventListener("click", () => {
      if (seg.dataset.dragged) { delete seg.dataset.dragged; return; }
      if (bandSelect.value !== name) { bandSelect.value = name; fire(bandSelect); }
    });
    segs[name] = seg;
    box.append(seg);
  }
  box.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const list = Object.values(segs);
    const i = list.indexOf(document.activeElement);
    list[(i + d + list.length) % list.length]?.focus();   // Enter or Space selects (a band change reloads)
  });

  function paintProposal(seg, lo, hi) {
    seg.querySelector(".wl-prop")?.remove();
    seg.append(make("span", { class: "wl-prop", style: `left:${((lo - 1) / N_CH) * 100}%;width:${((hi - lo + 1) / N_CH) * 100}%` }));
  }
  function paint() {
    for (const [name, seg] of Object.entries(segs)) {
      const on = name === view.band;
      seg.setAttribute("aria-checked", String(on));
      seg.tabIndex = on ? 0 : -1;
      seg.querySelector(".wl-prop")?.remove();
      [...seg.querySelectorAll(".wl-ticks i")].forEach((t, i) => {
        const k = i + 1;
        t.classList.toggle("in", on && !!view.range && k >= view.range.lo && k <= view.range.hi);
        t.classList.toggle("gap", view.gapsDet === name && !!view.gaps?.has(k));
        t.title = view.gapsDet === name && view.gaps?.has(k) ? `Channel ${k}: missing from at least one pass` : "";
      });
      if (on && view.proposal) paintProposal(seg, view.proposal.lo, view.proposal.hi);
    }
  }
  bandSelect.addEventListener("change", () => { view.band = bandSelect.value; view.proposal = null; paint(); });
  paint();
  box.hidden = false;
  return {
    update(v) { view = { ...view, ...v }; paint(); },
  };
}
