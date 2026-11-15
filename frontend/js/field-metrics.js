// Field summary and selected-pixel readouts for the Advanced drawer (ported from Z's "frontend pass 1").
// Scientific readouts use response metadata and loaded arrays, never inferred FITS headers.
// IMAGE is surface brightness (MJy/sr); fitted spectrum fluxes are a separate µJy product.
const NATIVE_PIXEL_ARCSEC = 6.15;
const JULIAN_YEAR_DAYS = 365.25;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const numericArray = (value) => Array.isArray(value) || ArrayBuffer.isView(value);
const fmt = (value, digits = 3) => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "Unknown";
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const representativeMjd = (frame) => finite(frame.mjd_mean) ? frame.mjd_mean
  : finite(frame.mjd_start) && finite(frame.mjd_end) ? (frame.mjd_start + frame.mjd_end) / 2 : null;
const unitLabel = (units) => typeof units === "string" && units.trim() ? units.trim() : null;
const isBrightnessUnit = (units) => typeof units === "string" && /^MJy\s*\/\s*sr$/.test(units);

/** Pure calculations, exported so numerical and missing-data behavior can be checked offline. */
export function deriveAdvanced({ frames: response = null, spectrum = null, source = null, selectedPixel = null, resolved = null } = {}) {
  const frames = Array.isArray(response?.frames) ? response.frames : [];
  const wcs = response?.wcs || {};
  const shapeKnown = Number.isInteger(wcs.width) && wcs.width > 0 && Number.isInteger(wcs.height) && wcs.height > 0;
  const size = shapeKnown ? wcs.width * wcs.height : null;
  const loaded = frames.filter((frame) => size && numericArray(frame.data) && frame.data.length === size && frame.width === wcs.width && frame.height === wcs.height);
  const times = frames.map(representativeMjd);
  const timed = frames.map((frame, index) => ({ frame, time: times[index] })).filter(({ time }) => finite(time)).sort((a, b) => a.time - b.time);
  const first = timed[0]?.frame, last = timed.at(-1)?.frame;
  const baselineDays = timed.length === frames.length && timed.length > 1 ? timed.at(-1).time - timed[0].time : null;
  const allEdges = frames.length && frames.every((frame) => finite(frame.mjd_start) && finite(frame.mjd_end));
  const observationSpanDays = allEdges ? Math.max(...frames.map((frame) => frame.mjd_end)) - Math.min(...frames.map((frame) => frame.mjd_start)) : null;
  const coverage = loaded.length === frames.length && frames.length > 0
    ? loaded.reduce((sum, frame) => sum + Array.from(frame.data).filter(finite).length, 0) / (size * frames.length) : null;
  const scale = finite(wcs.pixel_scale_arcsec) && wcs.pixel_scale_arcsec > 0 ? wcs.pixel_scale_arcsec : null;
  const wavelengths = frames.map((frame) => frame.lam_eff_um).filter((value) => finite(value) && value > 0);
  const wavelengthSpread = wavelengths.length === frames.length && wavelengths.length > 1 ? Math.max(...wavelengths) - Math.min(...wavelengths) : null;
  const matched = response?.matched === true && Array.isArray(response.matched_channels) && response.matched_channels.length > 0;
  const exposureCount = frames.length > 0 && frames.every((frame) => Number.isInteger(frame.n_exposures) && frame.n_exposures >= 0)
    ? frames.reduce((sum, frame) => sum + frame.n_exposures, 0) : null;
  const targetFlagsKnown = frames.length > 0 && frames.every((frame) => Array.isArray(frame.target_flags));
  const targetFlags = targetFlagsKnown ? [...new Set(frames.flatMap((frame) => frame.target_flags))] : null;
  const astrometry = frames.map((frame) => finite(frame.astrometry_rms_arcsec) ? frame.astrometry_rms_arcsec : frame.astrometry?.rms_arcsec);
  const astrometryRms = astrometry.length > 0 && astrometry.every((value) => finite(value) && value >= 0) ? Math.max(...astrometry) : null;
  let index = null;
  if (shapeKnown && selectedPixel) {
    if (Number.isInteger(selectedPixel.index) && selectedPixel.index >= 0 && selectedPixel.index < size) index = selectedPixel.index;
    else if (Number.isInteger(selectedPixel.x) && Number.isInteger(selectedPixel.y) && selectedPixel.x >= 0 && selectedPixel.x < wcs.width && selectedPixel.y >= 0 && selectedPixel.y < wcs.height) index = selectedPixel.y * wcs.width + selectedPixel.x;
  }
  const pairLoaded = index !== null && first && last && first !== last && loaded.includes(first) && loaded.includes(last);
  const units = unitLabel(response?.units);
  const pixelDelta = pairLoaded && finite(first.data[index]) && finite(last.data[index]) ? last.data[index] - first.data[index] : null;
  const noiseA = first?.noiseData || first?.noise, noiseB = last?.noiseData || last?.noise;
  const mapsLoaded = pairLoaded && numericArray(noiseA) && numericArray(noiseB) && noiseA.length === size && noiseB.length === size;
  const sourceKind = typeof source === "string" ? source : source?.kind;
  const calibrated = finite(first?.noise_scale) && first.noise_scale > 0 && finite(last?.noise_scale) && last.noise_scale > 0;
  const sigmaReady = mapsLoaded && calibrated && matched && ["live", "precomputed"].includes(sourceKind) && isBrightnessUnit(units) && finite(noiseA[index]) && noiseA[index] > 0 && finite(noiseB[index]) && noiseB[index] > 0;
  const pixelError = sigmaReady ? Math.hypot(noiseA[index], noiseB[index]) : null;
  const pixelPull = finite(pixelDelta) && pixelError > 0 ? pixelDelta / pixelError : null;
  const spectrumPoints = Array.isArray(spectrum?.points) ? spectrum.points : [];
  const usable = spectrumPoints.filter((point) => point.flagged === false && finite(point.flux) && finite(point.flux_err) && point.flux_err > 0 && point.fit !== "failed");
  const spectrumSnr = usable.length ? median(usable.map((point) => point.flux / point.flux_err)) : null;
  const totalPm = finite(resolved?.pmra) && finite(resolved?.pmdec) ? Math.hypot(resolved.pmra, resolved.pmdec) : null;
  return { frameCount: frames.length, baselineDays, observationSpanDays, coverage, scale,
    nativePixelArcsec: NATIVE_PIXEL_ARCSEC, resampling: scale ? NATIVE_PIXEL_ARCSEC / scale : null,
    fieldWidthArcmin: shapeKnown && scale ? wcs.width * scale / 60 : null,
    fieldHeightArcmin: shapeKnown && scale ? wcs.height * scale / 60 : null,
    exposureCount, wavelengthSpread, matched, matchedChannels: matched ? response.matched_channels.length : null,
    effectiveWavelength: finite(response?.lam_eff_um) && response.lam_eff_um > 0 ? response.lam_eff_um : null,
    targetFlags, astrometryRms, selectedIndex: index, pixelDelta, pixelError, pixelPull, units,
    pairLabel: first && last && first !== last ? `${last.epoch_label} − ${first.epoch_label}` : null,
    spectrumCount: spectrumPoints.length, usableSpectrumCount: usable.length, spectrumSnr,
    totalPm, predictedShift: finite(totalPm) && finite(baselineDays) ? totalPm / 1000 * baselineDays / JULIAN_YEAR_DAYS : null,
    sourceKind, release: typeof response?.release === "string" ? response.release : null,
    approximateEpochTimes: frames.some((frame) => !finite(frame.mjd_mean)),
  };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function addMetric(grid, label, value, explanation, kind = "Derived") {
  const item = element("div", undefined, "science-metric");
  item.append(element("dt", label));
  item.append(element("dd", value ?? "Unknown"));
  item.append(element("small", `${kind}. ${explanation}`, "science-note"));
  grid.append(item);
}

/** Render the field summary into a container. Missing measurements stay Unknown. */
export function renderFieldMetrics(container, input = {}) {
  if (!container) return;
  const d = deriveAdvanced(input);
  container.replaceChildren();
  const provenance = element("p", undefined, "science-provenance");
  const sourceLabels = { live: "Live backend", precomputed: "Saved SPHEREx observations", mock: "Synthetic demonstration" };
  provenance.textContent = `Data: ${sourceLabels[d.sourceKind] || "Unknown source"} · Release: ${d.release || "Unknown"}`;
  container.append(provenance);
  if (input.error) container.append(element("p", String(input.error), "science-note science-warning"));
  if (d.sourceKind === "mock") container.append(element("p", "Synthetic data: these numbers demonstrate the calculations and cannot support a discovery.", "science-note science-warning"));
  const grid = element("dl", undefined, "science-grid");
  addMetric(grid, "Observation periods", d.frameCount || "Unknown", "An epoch groups observations from one sky pass.", "Response metadata");
  addMetric(grid, "Epoch baseline", finite(d.baselineDays) ? `${fmt(d.baselineDays, 2)} days · ${fmt(d.baselineDays / JULIAN_YEAR_DAYS, 3)} years` : "Unknown", `Latest − earliest mean MJD.${d.approximateEpochTimes ? " A midpoint is used where a mean MJD is missing." : ""}`);
  addMetric(grid, "Total observing span", finite(d.observationSpanDays) ? `${fmt(d.observationSpanDays, 2)} days` : "Unknown", "Latest exposure end − earliest exposure start; gaps are included.");
  addMetric(grid, "Contributing exposures", d.exposureCount === null ? "Unknown" : fmt(d.exposureCount, 0), "Sum of n_exposures across displayed epochs.");
  addMetric(grid, "Output pixel sampling", d.scale ? `${fmt(d.scale)}″ / pixel` : "Unknown", "Sampling of the resampled grid; this is not the angular resolution.", "WCS metadata");
  addMetric(grid, "Native detector pixel", `${NATIVE_PIXEL_ARCSEC}″`, `Instrument reference.${d.resampling ? ` Output grid samples each native pixel about ${fmt(d.resampling, 2)}× per axis.` : ""} Resampling creates no new resolving power.`, "IRSA documentation");
  addMetric(grid, "Grid field of view", finite(d.fieldWidthArcmin) ? `${fmt(d.fieldWidthArcmin)}′ × ${fmt(d.fieldHeightArcmin)}′` : "Unknown", "Grid dimensions × pixel scale / 60; tangent-plane angular approximation.");
  addMetric(grid, "Finite image pixels", finite(d.coverage) ? `${fmt(100 * d.coverage, 2)}%` : "Unknown", "Finite pixels / all pixels across loaded frames. This is coverage, not a guarantee of photometric quality.");
  addMetric(grid, "Wavelength matching", d.matched ? `${d.matchedChannels} shared channels` : input.frames?.matched === false ? "Unmatched" : "Unknown", "Only an explicit matched response with a shared-channel list confirms bandpass matching.", "Response metadata");
  addMetric(grid, "Matched effective wavelength", finite(d.effectiveWavelength) ? `${fmt(d.effectiveWavelength, 4)} µm` : "Unknown", "Effective wavelength reported by the backend, when supplied.", "Response metadata");
  addMetric(grid, "Epoch wavelength spread", finite(d.wavelengthSpread) ? `${fmt(d.wavelengthSpread, 4)} µm` : "Unknown", "Maximum − minimum epoch effective wavelength. Different sampling can imitate brightness changes.");
  addMetric(grid, "Target quality flags", d.targetFlags ? d.targetFlags.length ? d.targetFlags.join(", ") : "None reported" : "Unknown", "Flags concern the field centre. They are not a quality assessment of every clicked pixel.", "Response metadata");
  addMetric(grid, "Largest registration scatter", finite(d.astrometryRms) ? `${fmt(d.astrometryRms)}″` : "Unknown", "Maximum reported per-epoch Gaia reference-star RMS; not the uncertainty of an individual source.", "Response metadata");
  addMetric(grid, "Selected pixel change", finite(d.pixelDelta) && d.units ? `${fmt(d.pixelDelta, 5)} ${d.units}` : "Unknown", `${d.pairLabel || "Latest − earliest epoch"}. Click an image pixel. Surface brightness is not integrated source flux.`);
  addMetric(grid, "Difference / background noise", finite(d.pixelPull) ? `${fmt(d.pixelPull, 2)} σ` : "Unknown", "ΔI / √(σearly² + σlate²), assuming independent epochs. Requires matched channels, loaded calibrated noise maps, known units, and real data. A residual is not a discovery significance.");
  addMetric(grid, "Usable spectrum measurements", input.spectrum ? `${d.usableSpectrumCount} / ${d.spectrumCount}` : "Unknown", "Only unflagged finite fluxes with positive finite uncertainties are used; failed fits are excluded.");
  addMetric(grid, "Median spectral signal / noise", finite(d.spectrumSnr) ? fmt(d.spectrumSnr, 2) : "Unknown", "Median Fν / σF over usable measurements. Flux and uncertainty are both µJy; the ratio is dimensionless.");
  if (finite(d.totalPm)) {
    addMetric(grid, "Field-centre catalog motion", `${fmt(d.totalPm, 1)} mas / year`, `For ${input.resolved?.name || "the named field-centre target"}, not an arbitrary clicked star. √(pmra² + pmdec²); pmra already includes cos(dec). A catalog value, not a new measurement.`);
    addMetric(grid, "Predicted target displacement", finite(d.predictedShift) ? `${fmt(d.predictedShift)}″` : "Unknown", "For the named field-centre target. Proper motion × epoch baseline / 1000 / 365.25. Linear prediction; parallax is excluded.");
  }
  container.append(grid);
  container.append(element("p", "Check wavelength coverage, flags, registration, and repeat observations before interpreting a change. Reprojected neighbouring pixels are correlated; a pixel-noise ratio is not an integrated source detection. Unknown means the response did not provide a usable measurement.", "science-note"));
  const references = element("p", "Methods and units: ", "science-note science-references");
  for (const [index, [label, url]] of [
    ["IRSA SPHEREx data products", "https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/"],
    ["IRSA spectrophotometry", "https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html"],
  ].entries()) {
    if (index) references.append(document.createTextNode(" · "));
    const link = element("a", label);
    link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
    references.append(link);
  }
  container.append(references);
}
