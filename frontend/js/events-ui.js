// Events list beside the viewer, the per-event detail card (per-pass S/N strip, "Is it new?" checks, report).
// Owner: C.
import { KIND_INFO, FLAG_INFO, boxSNR } from "./changes.js";
import { kindColour, skyToPixel } from "./overlays.js";
import { draw } from "./render.js";

const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d));
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((x) => x != null));
  return e;
};
export { el };

export { mjdDate } from "./coordinates.js";

function kindLabel(e) {
  if (e.kind === "known_mover" && e.known?.gaia) return "Known mover (Gaia)";
  return KIND_INFO[e.kind]?.label || e.kind;
}

export function renderEventList(ol, events, { selected, showLow, onSelect }) {
  ol.replaceChildren();
  for (const e of events) {
    if (e.confidence === "low" && !showLow && e.id !== selected) continue;
    const info = KIND_INFO[e.kind] || {};
    const what = e.lightcurve ? `light curve χ²/dof ${fmt(e.chi2_dof)}`
      : e.kind === "moved" || e.from
      ? `${fmt(e.shift_arcsec)}″ shift${e.pm_mas_yr ? ` · ${fmt(e.pm_mas_yr / 1000, 2)}″/yr` : e.rate_arcsec_yr ? ` · ≈${fmt(e.rate_arcsec_yr)}″/yr` : ""}`
      : `${fmt(e.sigma)}σ`;
    const b = el("button", { type: "button", "aria-pressed": String(selected === e.id), onclick: () => onSelect(e) },
      el("span", { class: "shape", text: info.shape || "•", style: `color:${kindColour(e.kind)}`, "aria-hidden": "true" }),
      el("span", {}, el("b", { text: `${e.id} ` }), kindLabel(e)),
      e.confidence === "low" ? el("span", { class: "low", text: "uncertain" }) : el("span", { class: "k", text: e.kind === "candidate" ? "★" : "" }),
      el("span", { class: "meta", text: `${what}${e.ra != null ? ` · ${e.ra.toFixed(4)}°, ${e.dec >= 0 ? "+" : ""}${e.dec.toFixed(4)}°` : ""}` }));
    ol.append(el("li", {}, b));
  }
}

/** Per-pass state at the event's position: detected (≥5σ), faint (2–5σ), absent (<2σ), no_data. */
export function passStates(e, frames, wcs, sources) {
  const w = wcs.width, h = wcs.height;
  return frames.map((f) => {
    // a mover is measured where it is in that pass
    let p = { x: e.x, y: e.y };
    const tp = e.track?.passes?.find((q) => q.epoch_label === f.epoch_label);
    const g = e.known?.gaia && sources?.find((s) => s.id === e.known.gaia)?.positions_by_epoch.find((q) => q.epoch_label === f.epoch_label);
    if (tp) p = skyToPixel(tp.ra, tp.dec, wcs);
    else if (g) p = skyToPixel(g.ra, g.dec, wcs);
    const i = Math.floor(p.y) * w + Math.floor(p.x);
    const inside = p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
    const snr = inside && f.noise ? boxSNR(f, i, w, h) : null;
    // a masked centre with data around it is a saturated core, not an empty spot
    const state = !inside ? "no_data" : f.data[i] === null ? (snr == null ? "no_data" : "masked")
      : snr == null ? "unknown" : snr >= 5 ? "detected" : snr >= 2 ? "faint" : "absent";
    return { epoch_label: f.epoch_label, mjd: f.mjd_mean ?? f.mjd_start, snr, state, x: p.x, y: p.y };
  });
}

function cutout(frame, cx, cy, wcs, half, limits) {
  const w = wcs.width, n = 2 * half + 1, out = new Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const X = Math.floor(cx) - half + x, Y = Math.floor(cy) - half + y;
    out[y * n + x] = X < 0 || Y < 0 || X >= w || Y >= wcs.height ? null : frame.data[Y * w + X];
  }
  return { data: out, n, limits };
}

/** External "is it new?" checks at a position (all open in a new tab; nothing is sent but the coordinates). */
export function checkLinks(ra, dec, mjd) {
  const c = `${ra.toFixed(6)} ${dec >= 0 ? "+" : ""}${dec.toFixed(6)}`;
  const enc = encodeURIComponent(c);
  const links = [
    ["SIMBAD", `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${enc}&Radius=10&Radius.unit=arcsec`, "Known objects of any kind within 10″"],
    ["CatWISE", `https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-source=II/365/catwise&-c=${enc}&-c.rs=10&-out.add=_r&-sort=_r`, "Infrared catalogue with motions; finds red objects Gaia misses"],
    ["Gaia DR3", `https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-source=I/355/gaiadr3&-c=${enc}&-c.rs=10&-out.add=_r&-sort=_r`, "Gaia stars within 10″"],
    ["IRSA Finder Chart", `https://irsa.ipac.caltech.edu/applications/finderchart/?locstr=${enc}`, "Older images of this spot (2MASS, WISE, SDSS, DSS)"],
  ];
  if (mjd) {
    const jd = (mjd + 2400000.5).toFixed(5);
    links.push(["SkyBoT", `https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ep=${jd}&-ra=${ra.toFixed(6)}&-dec=${dec.toFixed(6)}&-rd=0.01&-mime=html&-output=object&-loc=500`, "Known asteroids and comets here at that time (geocentric)"]);
  }
  return links;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export { download };

export function eventReport(e, ctx) {
  const { target, frames, A, B, matched, band, passes, release } = ctx;
  return {
    tool: "SPHEREx Sky Explorer", generated: new Date().toISOString(), release: release || null,
    target: target && { label: target.label, ra: target.ra, dec: target.dec },
    band, matched, compared: { a: A.epoch_label, b: B.epoch_label },
    event: {
      id: e.id, kind: e.kind, ra: e.ra, dec: e.dec, sigma_change: e.sigma, confidence: e.confidence, flags: e.flags,
      shift_arcsec: e.shift_arcsec ?? null, pm_mas_yr: e.pm_mas_yr ?? e.track?.pm ?? null, known: e.known ?? null,
      passes: passes.map((p) => ({ epoch_label: p.epoch_label, mjd: p.mjd, snr: p.snr, state: p.state })),
    },
    frames: frames.map((f) => ({ epoch_label: f.epoch_label, mjd_mean: f.mjd_mean, n_exposures: f.n_exposures, lam_eff_um: f.lam_eff_um, obs_ids: f.obs_ids })),
    checks: Object.fromEntries(checkLinks(e.ra, e.dec, B.mjd_mean).map(([k, u]) => [k, u])),
    method: "σ = (B − A) / sqrt(σA² + σB² + (0.1·max(|A|,|B|))²) on the co-added pass frames; regions ≥ 5σ.",
  };
}

const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\n");

export function renderEventDetail(box, e, ctx) {
  if (!e) { box.hidden = true; box.replaceChildren(); return; }
  const { frames, wcs, sources, A, B, fitsURL, onSpectrum, onZoom } = ctx;
  box.hidden = false;
  const info = KIND_INFO[e.kind] || {};
  const passes = passStates(e, frames, wcs, sources);
  const head = el("h3", {}, el("span", { text: `${info.shape || "•"} `, style: `color:${kindColour(e.kind)}` }), `${e.id} · ${kindLabel(e)}`);
  const lines = [];
  if (e.kind === "known_mover" && e.known?.gaia) lines.push(`${e.known.gaia} moves ${fmt(e.pm_mas_yr / 1000, 2)}″/yr. Real, and already in Gaia.`);
  if (e.track) lines.push(`Movers search: ${fmt(e.track.pm / 1000, 2)} ± ${fmt(e.track.pm_err / 1000, 2)}″/yr (${fmt(e.track.pm_sigma)}σ), ${e.track.gaia ? `matches ${e.track.gaia.id || "Gaia"}` : "no Gaia match"}.`);
  if (e.lightcurve) lines.push(`Light curve: χ²/dof = ${fmt(e.chi2_dof)} against constant brightness (> 5 means it varies), with quiet comparison stars. See Advanced → Photometry.`);
  if (e.absorbed?.length) lines.push(`Explains ${e.absorbed.length} change region${e.absorbed.length > 1 ? "s" : ""} between ${A.epoch_label} and ${B.epoch_label}.`);
  if (!e.track && !e.known && !e.lightcurve) lines.push(`Change ${fmt(e.sigma)}σ between ${A.epoch_label} and ${B.epoch_label}${e.shift_arcsec ? `, shifted ${fmt(e.shift_arcsec)}″` : ""}.`);

  // per-pass strip: small cutouts with S/N and state
  const half = 8;
  const all = passes.flatMap((p) => { const f = frames.find((x) => x.epoch_label === p.epoch_label); return cutout(f, p.x, p.y, wcs, half).data; });
  const finite = all.filter((v) => v !== null).sort((a, b) => a - b);
  const lim = finite.length ? [finite[Math.floor(finite.length * 0.02)], finite[Math.floor(finite.length * 0.995)]] : [0, 1];
  const strip = el("div", { class: "strip", role: "list", "aria-label": "Each pass at this position" });
  for (const p of passes) {
    const f = frames.find((x) => x.epoch_label === p.epoch_label);
    const c = cutout(f, p.x, p.y, wcs, half);
    const cv = el("canvas", { width: c.n, height: c.n, "aria-hidden": "true" });
    draw(cv, c.data, c.n, c.n, { range: lim[1] > lim[0] ? lim : [lim[0], lim[0] + 1], stretch: "asinh" });
    const st = { detected: "detected", faint: "faint", absent: "not seen", no_data: "no data", masked: "core masked", unknown: "?" }[p.state];
    strip.append(el("figure", { role: "listitem" }, cv,
      el("figcaption", {}, el("b", { text: p.epoch_label }), el("br"),
        el("span", { class: `st-${p.state}`, text: `${p.snr == null || p.state === "masked" ? "" : `${fmt(p.snr)}σ `}${st}` }))));
  }
  const flags = e.flags?.length ? el("ul", { class: "flags" }, ...e.flags.map((f) => el("li", { text: FLAG_INFO[f] || f }))) : null;
  const caveat = (e.kind === "appeared" || e.kind === "disappeared")
    ? el("p", { class: "hint", text: "With only a few passes so far, most things seen in one pass only are asteroids or artefacts. Check SkyBoT for known asteroids." })
    : null;

  const checks = el("div", { class: "checks" }, el("span", { class: "k", text: "Is it new?" }),
    ...checkLinks(e.ra, e.dec, B.mjd_mean).map(([label, href, title]) => el("a", { class: "btn", href, target: "_blank", rel: "noopener", title, text: label })));

  const report = () => eventReport(e, { ...ctx, passes });
  const actions = el("div", { class: "checks" },
    el("button", { type: "button", text: "Spectrum here", onclick: () => onSpectrum(e) }),
    el("button", { type: "button", text: "Zoom in", onclick: () => onZoom(e) }),
    el("button", { type: "button", text: "Report (JSON)", title: "Download everything needed to send this candidate to a professional", onclick: () => download(`spherex-${e.id}.json`, JSON.stringify(report(), null, 2), "application/json") }),
    el("button", { type: "button", text: "CSV", onclick: () => {
      const r = report();
      download(`spherex-${e.id}.csv`, toCSV([["id", "kind", "ra", "dec", "sigma", "confidence", "pass", "mjd", "snr", "state"],
        ...r.event.passes.map((p) => [e.id, e.kind, e.ra, e.dec, e.sigma, e.confidence, p.epoch_label, p.mjd, p.snr, p.state])]), "text/csv");
    } }),
    fitsURL ? el("a", { class: "btn", href: fitsURL, target: "_blank", rel: "noopener", text: "FITS cutout" }) : null);

  box.replaceChildren(...[head, el("p", { text: info.text || "" }), ...lines.map((t) => el("p", { text: t })), strip, flags, caveat, checks, actions].filter(Boolean));
}
