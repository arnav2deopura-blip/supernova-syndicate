// Advanced drawer for professionals: per-pass and per-exposure metadata, astrometry, photometry, derived physics
// and exports. Rule: never fabricate — a missing value shows "Unknown" with the reason on hover. Owner: C.
import { el, download, toCSV, mjdDate } from "./events-ui.js";
import { renderFieldMetrics } from "./field-metrics.js";
import { galactic, ecliptic, distance, tangentialVelocity, passMagnitudes, reducedPM, blackbodyT, falseAlarms } from "./astro.js";

const f = (v, d = 2) => (v == null || !Number.isFinite(+v) ? null : (+v).toFixed(d));
const unk = (why) => el("span", { class: "unknown", title: why, tabindex: "0", text: "Not available" });
/** A value, or Unknown with a reason. */
const val = (v, why, unit = "") => (v == null ? unk(why) : `${v}${unit}`);

function table(headers, rows) {
  const visible=headers.map((_,i)=>i).filter(i=>rows.some(row=>row[i]!=null && !(row[i] instanceof Element && row[i].classList.contains('unknown'))));
  rows=rows.map(row=>visible.map(i=>row[i])); headers=visible.map(i=>headers[i]);
  const t = el("table");
  t.append(el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { class: h.num ? "num" : "", text: h.label ?? h })))));
  const tb = el("tbody");
  for (const r of rows) tb.append(el("tr", {}, ...r.map((c, i) => el("td", { class: headers[i]?.num ? "num" : "" }, c ?? unk("Not in the response")))));
  t.append(tb);
  return t;
}
const dl = (pairs) => el("dl", {}, ...pairs.filter(([,v])=>!(v instanceof Element && v.classList.contains('unknown'))).flatMap(([k, v, formula]) => [el("dt", { text: k }), el("dd", {}, v, formula ? el("div", { class: "formula", text: formula }) : null)]));
const section = (title, ...kids) => el("section", {}, el("h3", { text: title }), ...kids);
const loadingOr = (state, why, build) => (state === "loading" ? el("p", { class: "hint", text: "Loading…" })
  : state?.error ? el("p", { class: "hint" }, unk(state.error), ` — ${state.error}`) : !state ? el("p", { class: "hint", text: why }) : build(state));

export { deriveAdvanced } from "./field-metrics.js";

export function renderAdvanced(body, ctx) {
  const { target, resp, band, matched, exposures, motion, lightcurve, movers, events, spectrum, threshold, fitsURL, sexa, pick } = ctx;
  if (!target || !resp) { body.replaceChildren(el("p", { class: "hint", text: "Load a target first." })); return; }
  const frames = resp.frames;
  const out = [];

  // ---- passes ----
  out.push(section("Passes",
    el("p", { class: "hint", text: `${band}${matched ? `, matched channels ${resp.matched_channels?.join(", ") || "?"} (λ_eff ${f(resp.lam_eff_um, 3) ?? "?"} µm)` : ""} · release ${resp.release || "unknown"} · ${resp.units || "units not supplied"}` }),
    table(["Pass", "Dates", { label: "MJD mean", num: true }, { label: "Exp. used", num: true }, { label: "dropped", num: true }, { label: "λ_eff µm", num: true },
      { label: "noise ×", num: true }, { label: "reg. offset ″", num: true }, { label: "reg. rms ″", num: true }, { label: "flagged %", num: true }, "Target flags"],
    frames.map((fr) => [
      fr.epoch_label, `${mjdDate(fr.mjd_start)} – ${mjdDate(fr.mjd_end)}`,
      val(f(fr.mjd_mean, 2), "No mean MJD in this response"),
      String(fr.n_exposures ?? "?"),
      val(fr.n_exposures_dropped, "Only reported for matched frames"),
      val(f(fr.lam_eff_um, 3), "Not reported for this frame"),
      val(f(fr.noise_scale, 3), "Absent with a single frame or no noise map"),
      fr.astrometry ? `${f(fr.astrometry.dra_arcsec, 3)}, ${f(fr.astrometry.ddec_arcsec, 3)}` : unk("No Gaia registration (Gaia unreachable when built)"),
      val(f(fr.astrometry_rms_arcsec, 3), "No Gaia registration"),
      val(f(fr.flag_fraction != null ? fr.flag_fraction * 100 : null, 2), "Not reported"),
      Array.isArray(fr.target_flags) ? (fr.target_flags.join(" ") || "none reported") : unk("Target flags were not supplied"),
    ]))));

  // ---- field summary and the clicked pixel (first vs last pass) ----
  const fm = el("div");
  renderFieldMetrics(fm, {
    frames: resp, spectrum, source: resp._provenance,
    selectedPixel: pick ? { x: Math.floor(pick.x), y: Math.floor(pick.y) } : null,
    resolved: target.pm ? { pmra: target.pm.pmra, pmdec: target.pm.pmdec, name: target.label } : null,
  });
  out.push(section("Field summary and selected pixel", fm));

  // ---- exposures ----
  out.push(section("Exposures",
    loadingOr(exposures, "Open the drawer to load the exposure list.", (ex) => {
      const det = +band.slice(1);
      const mine = (ex.exposures || []).filter((e) => e.detector === det);
      return el("div", {},
        el("p", { class: "hint", text: `${mine.length} ${band} exposures (${(ex.exposures || []).length} in all bands). Times are MJD; wavelength and quality are shown only when measured by the pipeline.` }),
        table(["obs_id", { label: "MJD", num: true }, "Pass", { label: "λ at target µm", num: true }, { label: "flagged %", num: true }, "Target flags", "L2 file"],
          mine.slice(0, 200).map((e) => [e.obs_id, f(e.mjd, 3), e.epoch_label || "–",
            val(f(e.wavelength_um, 3), "Filled in once this detector's frames are built"),
            val(f(e.flags_summary?.flag_fraction != null ? e.flags_summary.flag_fraction * 100 : null, 2), "Not reported"),
            e.flags_summary?.target_flags ? e.flags_summary.target_flags.join(" ") || "none" : unk("Filled in once the frames are built"),
            e.url ? el("a", { href: e.url, target: "_blank", rel: "noopener", text: "FITS" }) : unk("No URL")])));
    })));

  // ---- astrometry ----
  out.push(section("Astrometry (SPHEREx-only proper motion)",
    loadingOr(motion, "Open the drawer to fit the motion.", (m) => {
      const fit = m.fit || {}, g = m.gaia;
      return dl([
        ["μα*", val(fit.pmra != null ? `${f(fit.pmra, 1)} ± ${f(fit.pmra_err, 1)}` : null, "No fit", " mas/yr")],
        ["μδ", val(fit.pmdec != null ? `${f(fit.pmdec, 1)} ± ${f(fit.pmdec_err, 1)}` : null, "No fit", " mas/yr")],
        ["Total μ", val(fit.pm_total != null ? `${f(fit.pm_total, 1)} ± ${f(fit.pm_total_err, 1)}` : null, "No fit", " mas/yr")],
        ["Position angle", val(fit.pa_deg != null ? `${f(fit.pa_deg, 2)} ± ${f(fit.pa_err_deg, 2)}` : null, "No fit", "°")],
        ["χ²/dof", val(f(fit.chi2_dof, 2), "No fit"), fit.n ? `${fit.n} exposures, ${fit.n_clipped ?? 0} clipped` : null],
        ["Bootstrap errors", val(fit.bootstrap ? `${f(fit.bootstrap.pmra_err, 1)}, ${f(fit.bootstrap.pmdec_err, 1)}` : null, "No bootstrap in the response", " mas/yr")],
        ["Parallax", val(fit.parallax != null ? `${f(fit.parallax, 2)}${fit.parallax_err != null ? ` ± ${f(fit.parallax_err, 2)}` : ""}` : null, "Not fitted", " mas"), fit.parallax_mode ? `mode: ${fit.parallax_mode}` : null],
        ["vs Gaia DR3", g ? `${f(g.pm_sigma_diff, 2)}σ (Gaia μ = ${f(g.pm_total, 1)} mas/yr)` : unk(m.catalog ? "Compared with the catalogue PM instead" : "Target not in Gaia")],
      ]);
    })));

  // ---- photometry ----
  const pm = passMagnitudes(spectrum?.points);
  out.push(section("Photometry",
    dl([
      ["Spectrum", spectrum?.points ? `${spectrum.points.length} points at ${f(spectrum.ra, 5)}, ${f(spectrum.dec, 5)} (${spectrum.points.filter((p) => p.flagged).length} flagged)` : unk("Click a star in the image to measure its spectrum")],
      ["AB mag (median)", pm.unknown ? unk(pm.unknown) : f(pm.value, 2), "m_AB = 23.9 − 2.5·log₁₀(f_ν / µJy)"],
      ["Per pass", pm.unknown ? unk(pm.unknown) : pm.per.map((p) => `${p.epoch_label} ${f(p.mag, 2)}`).join(" · ")],
      ["Δm (last − first)", pm.unknown ? unk(pm.unknown) : val(f(pm.dm, 3), "Needs unsaturated points in two passes"), "Bandpass differs per pass: compare with matched frames"],
    ]),
    loadingOr(lightcurve, "Open the drawer to load the light curve.", (lc) => dl([
      ["Light curve", `${lc.n_used}/${lc.n_points} points, ${lc.method}`],
      ["χ²/dof (constant)", lc.chi2_constant != null ? `${f(lc.chi2_constant, 1)} / ${lc.dof}` : unk("Not computed")],
      ["Variable?", lc.variable == null ? unk(lc.note || "No claim: unreliable photometry") : lc.variable ? "yes" : "no", lc.systematic_floor ? `floor ${f(lc.systematic_floor * 100, 1)} %, comparison rms ${f((lc.comparison_stars?.rms_scale ?? NaN) * 100, 1) ?? "?"} %` : null],
      ["Reliable", lc.reliable === false ? `no — ${lc.note || ""}` : lc.reliable ? "yes" : unk("Not reported")],
      ["Period", lc.period ? `${f(lc.period.period_days ?? lc.period.best_days, 1)} d` : unk("Needs ≥ 6 bins")],
    ]))));

  // ---- movers & events ----
  out.push(section("Movers and change events",
    loadingOr(movers, "The movers search runs when a target loads.", (mv) => el("div", {},
      el("p", { class: "hint", text: `${mv.n_passes} passes · null test pull widths ${mv.null_test?.pull_robust_std?.map((x) => f(x, 2)).join(", ") ?? "?"} (≈1 = honest errors)` }),
      table(["Track", "Status", { label: "μ mas/yr", num: true }, { label: "σ", num: true }, { label: "S/N min", num: true }, "Gaia"],
        mv.tracks.filter((t) => t.status !== "stationary").map((t) => [t.id, t.status, `${f(t.pm, 0)} ± ${f(t.pm_err, 0)}`, f(t.pm_sigma, 1), f(t.snr_min, 1), t.gaia?.id || t.gaia?.source_id || (t.gaia ? "yes" : "none")])),
      el("p", { class: "hint", text: `${mv.tracks.filter((t) => t.status === "stationary").length} stationary tracks not listed.` }))),
    events?.length ? table(["Event", "Kind", { label: "σ", num: true }, "Conf.", "RA", "Dec", "Flags"],
      events.map((e) => [e.id, e.kind, f(e.sigma, 1), e.confidence, f(e.ra, 5), f(e.dec, 5), e.flags.join(" ") || "–"])) : el("p", { class: "hint", text: "No change events." }),
    el("p", { class: "formula", text: `False alarms from noise alone: ≈${f(falseAlarms(resp.wcs.width * resp.wcs.height, threshold), 4)} pixels beyond ±${threshold}σ in this ${resp.wcs.width}×${resp.wcs.height} field (Gaussian noise; stars add systematics, hence the 10 % brightness floor).` })));

  // ---- coordinates ----
  const gal = galactic(target.ra, target.dec), ecl = ecliptic(target.ra, target.dec);
  out.push(section("Coordinates (field centre)", dl([
    ["ICRS", `${f(target.ra, 6)}°, ${f(target.dec, 6)}°`, sexa],
    ["Galactic", `l = ${f(gal.l, 4)}°, b = ${f(gal.b, 4)}°`],
    ["Ecliptic (J2000)", `λ = ${f(ecl.lon, 4)}°, β = ${f(ecl.lat, 4)}°`, Math.abs(ecl.lat) > 80 ? "Near an ecliptic pole: SPHEREx revisits often" : null],
  ])));

  // ---- derived physics ----
  const plx = motion?.fit?.parallax_mode === "fit" ? [motion.fit.parallax, motion.fit.parallax_err, "SPHEREx parallax fit"]
    : motion?.gaia?.parallax != null ? [motion.gaia.parallax, motion.gaia.parallax_err ?? null, "Gaia DR3"] : [null, null, null];
  const d = motion && !motion.error && motion !== "loading" ? distance(...plx) : { unknown: "Needs the astrometry fit (loading or unavailable)." };
  const pmTot = motion?.fit?.pm_total ?? (target.pm ? Math.hypot(target.pm.pmra, target.pm.pmdec) : null);
  const vt = tangentialVelocity(pmTot, d);
  const H = reducedPM(pm.unknown ? null : pm.value, pmTot);
  const T = blackbodyT(spectrum?.points);
  const show = (r, digits, unit) => (r.unknown ? unk(r.unknown) : `${f(r.value, digits)}${unit}`);
  out.push(section("Derived physics", dl([
    ["Distance", d.unknown ? unk(d.unknown) : `${f(d.value, 3)} ± ${f(d.err, 3)} pc (${d.source})`, "d [pc] = 1000 / ϖ [mas], only when ϖ/σϖ > 5"],
    ["Tangential velocity", show(vt, 1, " km/s"), "v_t = 4.74 · μ [″/yr] · d [pc]"],
    ["Reduced proper motion", show(H, 2, ""), "H = m + 5·log₁₀ μ[″/yr] + 5 — separates nearby dwarfs from distant giants without a parallax"],
    ["Colour temperature", T.unknown ? unk(T.unknown) : `≈${f(T.value, 0)} K (χ²/dof ${f(T.chi2_dof, 1)})`, "Rough Planck fit: brown dwarfs are not blackbodies"],
  ])));

  // ---- exports ----
  const exp = el("div", { class: "exports" });
  exp.append(el('button',{type:'button',text:'Observation metadata CSV',onclick:()=>download('observations.csv',toCSV([['epoch','mjd_start','mjd_end','exposures','units','effective_wavelength_um','flags','observation_ids'],...frames.map(fr=>[fr.epoch_label,fr.mjd_start,fr.mjd_end,fr.n_exposures,resp.units||'',fr.lam_eff_um,fr.target_flags?.join(';'),fr.obs_ids?.join(';')])]),'text/csv')}));
  if (fitsURL) exp.append(el("a", { class: "btn", href: fitsURL, target: "_blank", rel: "noopener", text: "Frames as FITS" }));
  else exp.append(el("span", {}, "Frames as FITS: ", unk("Needs the live backend (the offline bake has no FITS export)")));
  if (spectrum?.points) {
    exp.append(el("button", { type: "button", text: "Spectrum CSV", onclick: () => download("spectrum.csv", toCSV([["wavelength_um", "flux_uJy", "flux_err", "epoch", "flagged", "obs_id"], ...spectrum.points.map((p) => [p.wavelength_um, p.flux, p.flux_err, p.epoch_label, p.flagged, p.obs_id])]), "text/csv") }));
  }
  if (lightcurve && lightcurve.points) {
    exp.append(el("button", { type: "button", text: "Light curve CSV", onclick: () => download("lightcurve.csv", toCSV([["mjd", "lam_um", "flux_uJy", "flux_err", "scale", "scale_err", "flagged", "used"], ...lightcurve.points.map((p) => [p.mjd, p.lam_um, p.flux, p.flux_err, p.scale, p.scale_err, p.flagged, p.used])]), "text/csv") }));
  }
  if (movers?.tracks) exp.append(el("button", { type: "button", text: "Tracks JSON", onclick: () => download("tracks.json", JSON.stringify(movers.tracks, null, 2), "application/json") }));
  if (events?.length) exp.append(el("button", { type: "button", text: "Events CSV", onclick: () => download("events.csv", toCSV([["id", "kind", "ra", "dec", "sigma", "confidence", "flags"], ...events.map((e) => [e.id, e.kind, e.ra, e.dec, e.sigma, e.confidence, e.flags.join(" ")])]), "text/csv") }));
  const cite = `This research used SPHEREx data (NASA/IPAC IRSA; doi:10.26131/IRSA678, doi:10.26131/IRSA679), Gaia DR3 (ESA; Gaia Collaboration et al. 2023, A&A 674, A1), SIMBAD (CDS) and the SPHEREx Sky Explorer (Supernova Syndicate, NASA Space Apps 2026). Release: ${resp.release || "unknown"}.`;
  const copy = el("button", { type: "button", text: "Copy citation", onclick: async () => {
    try { await navigator.clipboard.writeText(cite); copy.textContent = "Copied ✓"; } catch { copy.textContent = "Select the text below"; }
  } });
  exp.append(copy);
  out.push(section("Exports", exp, el("pre", { text: cite })));

  const omitted=[];
  for (const item of out) {
    const lists=[...item.querySelectorAll('dl')];
    if (lists.length && lists.every(d=>!d.children.length) && !item.querySelector('table,button,a')) {omitted.push(item.querySelector('h3')?.textContent); continue;}

  }
  const visible=out.filter(item=>!omitted.includes(item.querySelector('h3')?.textContent));
  body.replaceChildren(...visible);
  if (omitted.length) body.append(el('p',{class:'hint',text:`Not shown: ${omitted.join(', ')}. These analyses need additional validated measurements for the selected object.`}));
}
