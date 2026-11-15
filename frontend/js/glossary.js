// Glossary tooltips: an ⓘ button next to a term, one plain-language sentence first, then the technical detail.
// Markup: <button type="button" class="info" data-term="fov"></button>. Owner: C.

export const GLOSSARY = {
  radec: ["RA / Dec", "The sky's longitude and latitude. RA (right ascension) goes around the sky in hours or degrees; Dec (declination) runs from −90° at the south pole to +90° at the north."],
  fov: ["Field of view", "How big a patch of sky you look at. 0.1° is about a fifth of the full Moon's width."],
  pass: ["Pass / epoch", "SPHEREx scans the whole sky once every ~6 months. Each pass is one frame of the movie (E1, E2, …). Comparing passes shows what changed."],
  band: ["Band / detector", "SPHEREx splits light into 6 detectors (D1–D6), from 0.75 to 5 µm. Each detector image here is the sum of its 17 colour channels, which gives the cleanest picture."],
  channel: ["Channel", "One of SPHEREx's 102 narrow colours (17 per detector). One channel is noisier than a whole detector, but it can pick out a molecule."],
  um: ["µm (micrometre)", "A wavelength unit: a millionth of a metre. Our eyes see 0.4–0.7 µm; SPHEREx sees 0.75–5 µm, which is infrared and invisible to us."],
  units: ["MJy/sr vs µJy", "MJy/sr is the brightness of each pixel (per patch of sky). µJy (micro-jansky) is the total light of one star, used in the spectrum."],
  pm: ["Proper motion", "How fast a star crawls across the sky, in arcseconds per year (″/yr) or milli-arcseconds per year (mas/yr). Barnard's Star moves 10″/yr, the fastest of any star."],
  sigma: ["σ (sigma) and S/N", "How sure we are a change is real: the change divided by the noise. 5σ means the change is 5 times bigger than the noise; random noise almost never does that."],
  matched: ["Fair brightness comparison (matched wavelengths)", "Each pass sees a slightly different mix of colours. This setting keeps only the colours seen in every pass, so a star that looks brighter really is brighter. Costs some exposures."],
  coadd: ["Co-add", "Several exposures of the same spot added together, so faint things stand out from the noise."],
  diff: ["Difference image", "Pass B minus pass A. Things that did not change cancel to grey; brighter is red, fainter is blue."],
  changes: ["Changes (σ) view", "The difference divided by the noise, so the colour tells you how significant a change is. Regions above 5σ are circled automatically."],
  dipole: ["Dipole", "A blue spot right next to a red one in a difference image: the star was at the blue spot in pass A and at the red spot in pass B. That is what motion looks like."],
  flags: ["Flags", "Warnings the SPHEREx pipeline stores per pixel. OVERFLOW = saturated (too bright to measure), TRANSIENT = a cosmic ray or similar hit, GHOST/PERSIST = optical or detector echoes of a bright star."],
  gaia: ["Gaia", "ESA's space telescope that measured positions and motions of ~2 billion stars. If Gaia already knows a moving star, it is not a new discovery."],
  contrast: ["Contrast (stretch)", "How brightness maps to grey. ‘Show faint things’ (asinh) brings out faint stars; ‘Linear’ keeps brightness proportional."],
  cap: ["Brightness cap (clip %)", "Pixels brighter than this percentile are shown as pure white, so a few bright stars don't make everything else black."],
  confidence: ["Confidence", "High: a clean change in empty sky with a fair comparison. Low (dashed): near a bright star, a data gap, or with mixed wavelengths. Check low-confidence events before believing them."],
};

let pop = null, owner = null;

function close() {
  if (!pop) return;
  pop.hidden = true;
  owner?.setAttribute("aria-expanded", "false");
  owner = null;
}

function open(btn) {
  const entry = GLOSSARY[btn.dataset.term];
  if (!entry) return;
  if (owner === btn) { close(); return; }
  close();
  pop.replaceChildren();
  const h = document.createElement("strong"); h.textContent = entry[0];
  const p = document.createElement("span"); p.textContent = entry[1];
  pop.append(h, p);
  pop.hidden = false;
  owner = btn;
  btn.setAttribute("aria-expanded", "true");
  const r = btn.getBoundingClientRect();
  const w = Math.min(300, innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + scrollX}px`;
  const below = r.bottom + 8 + pop.offsetHeight < innerHeight;
  pop.style.top = `${(below ? r.bottom + 8 : r.top - 8 - pop.offsetHeight) + scrollY}px`;
}

/** Set up every [data-term] button now and in the future (event delegation). */
export function initGlossary() {
  pop = document.createElement("div");
  pop.className = "gloss-pop";
  pop.id = "gloss-pop";
  pop.setAttribute("role", "tooltip");
  pop.hidden = true;
  document.body.append(pop);
  const decorate = (root) => root.querySelectorAll("button.info[data-term]").forEach((b) => {
    if (b.dataset.ready) return;
    b.dataset.ready = "1";
    b.textContent = "i";
    b.setAttribute("aria-label", `What is ${GLOSSARY[b.dataset.term]?.[0] || "this"}?`);
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-describedby", "gloss-pop");
  });
  decorate(document);
  new MutationObserver(() => decorate(document)).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.info[data-term]");
    if (b) { e.preventDefault(); e.stopPropagation(); open(b); return; }
    if (!e.target.closest(".gloss-pop")) close();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  addEventListener("resize", close);
}

/** An ⓘ button for a term, for code that builds DOM. */
export function infoButton(term) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "info"; b.dataset.term = term;
  return b;
}
