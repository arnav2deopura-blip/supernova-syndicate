// Tour steps and the "What am I looking at?" field guide. Both use the five precomputed test targets, so they
// never wait on a slow backend job. Owner: C.
import { el } from "./events-ui.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The 8 coach-mark steps. `h` = hooks from app.js. */
export function tourSteps(h) {
  const barnard = async () => { await h.choosePreset("barnards-star"); };
  return [
    {
      el: ".controls", title: "Pick a patch of sky",
      text: ["Three ways in: <b>explore</b> the all-sky map, type an <b>object name</b>, or enter <b>coordinates</b>.",
        "We'll use Barnard's Star, the fastest-moving star in the sky. Its data is ready, so nothing to wait for."],
      before: async () => { h.expandSearch(); h.setMode("name"); await barnard(); h.expandSearch(); },
    },
    {
      el: "#stage", title: "This is a little movie",
      text: ["Each frame is one SPHEREx <b>pass</b>: the telescope sweeps the whole sky about every 6 months.",
        "Watch for a dot that steps in one direction. Use <b>Play/Pause</b>, or the <kbd>←</kbd> <kbd>→</kbd> keys to step."],
      before: async () => { await barnard(); h.setView("blink"); h.play(true); },
    },
    {
      el: "#stage", title: "Spot the mover",
      text: ["<b>Difference</b> subtracts pass A from pass B. Things that stayed the same turn grey.",
        "Barnard's Star leaves a <b>blue spot</b> where it was and a <b>red spot</b> where it went: a “dipole”. It moves 10″ a year."],
      before: async () => { await barnard(); h.zoomTo(null, 3); h.setView("diff"); },
    },
    {
      el: "#events-panel", title: "Circles mark what changed",
      text: ["<b>Changes (σ)</b> shows how significant each change is, and circles regions above 5σ automatically: ○ brighter or new, ✕ fainter or gone, → moved. Dashed means uncertain.",
        "Here the change is explained by a star Gaia already knows moves, so it is listed as a <b>known mover</b>. Blue circles are Gaia stars."],
      before: async () => { await barnard(); h.setView("changes"); h.zoomTo(null, 1); },
    },
    {
      el: "#shared", title: "Colours of light",
      text: ["SPHEREx sees 102 infrared colours, from 0.75 to 5 µm, in 6 <b>bands</b> (D1–D6). Each band image adds 17 colours together for the clearest picture.",
        "Cool brown dwarfs like WISE 0855 are almost invisible in D1–D3 but glow in <b>D6</b>. “Pick channels” narrows to a few colours, e.g. to look for a molecule."],
      before: async () => { h.expandSearch(); },
    },
    {
      el: "#spectrum", title: "Click a star",
      text: ["Clicking a star measures its <b>spectrum</b>: how bright it is at each colour, one dot per exposure, coloured by pass.",
        "We just measured Barnard's Star. It is saturated in D2 (too bright), so treat these values as rough."],
      before: async () => { await barnard(); const t = h.state.target; await h.measureSpectrum(t.ra, t.dec); },
    },
    {
      el: "#event-detail", title: "Is it new?",
      text: ["Select an event to see it in <b>every pass</b>, with its signal-to-noise. A real mover is in every frame.",
        "Before you report anything, check SIMBAD, CatWISE, Gaia and SkyBoT (asteroids) with one click. <b>Report</b> downloads the details to send to a professional."],
      before: async () => {
        await barnard(); h.setView("changes");
        const e = h.state.events[0];
        if (e) h.selectEvent(e.id === h.state.selected ? e.id : e.id);
        await wait(50);
      },
    },
    {
      el: "#advanced", title: "For scientists",
      text: ["The <b>Advanced</b> drawer has the per-pass and per-exposure metadata, the proper-motion fit, light curves, derived physics and FITS/CSV exports. Only available measurements are shown. Analyses needing more data are summarized below the results.",
        "Restart this tour any time with the <b>?</b> button. Happy hunting!"],
      before: async () => { h.openAdvanced(false); },
    },
  ];
}

/** Field-guide cards: what real vs fake changes look like, each with a "Show me". */
const CARDS = [
  { title: "A real mover", tag: "real", img: "img/barnard_blink.gif",
    text: "It is in every pass and steps the same way each time. Barnard's Star moves 10″/yr: you can see it in three passes.",
    show: async (h) => { await h.choosePreset("barnards-star"); h.setView("blink"); h.zoomTo(null, 3); h.play(true); } },
  { title: "A faint, red mover", tag: "real",
    text: "WISE 0855 is the coldest known brown dwarf. Gaia can't see it; SPHEREx sees it only in the reddest band (D6). A pink → marks the movers-search candidate.",
    show: async (h) => { await h.choosePreset("wise-0855"); h.setView("changes"); const e = h.state.events.find((x) => x.kind === "candidate"); if (e) { h.selectEvent(e.id); h.zoomTo(e, 3); } } },
  { title: "A dipole", tag: "real",
    text: "In a difference image a moving star leaves a blue spot (old place) next to a red spot (new place). Slow movers look like a black-and-white “cookie”.",
    show: async (h) => { await h.choosePreset("barnards-star"); h.setView("diff"); h.zoomTo(null, 3); } },
  { title: "A variable star", tag: "real",
    text: "It stays in place but changes brightness: one colour only, no partner spot. Compare fairly (matched wavelengths), or a red star can fake it.",
    show: async (h) => { await h.choosePreset("rw-aur"); await h.setMatched(true); h.setView("changes"); h.zoomTo(null, 2); } },
  { title: "Artefact: a saturated star", tag: "fake",
    text: "Very bright stars overflow the detector. They leave rings, spikes and leftovers bigger than the noise, so markers there are dashed (uncertain). R Dra is saturated in D2.",
    show: async (h) => { await h.choosePreset("r-dra"); h.setView("diff"); h.zoomTo(null, 2); } },
  { title: "Artefact: a data gap", tag: "fake",
    text: "Transparent (black) pixels have no data: masked or off the edge. Something “missing” in a gap is not gone. Events touching gaps are marked uncertain.",
    show: async (h) => { await h.choosePreset("barnards-star"); h.setView("blink"); h.zoomTo(null, 4); h.play(false); } },
  { title: "Stars that all dance together", tag: "fake",
    text: "If every star shifts the same way at once, the frame is misaligned, not the stars moving. We register every pass on Gaia (see Advanced → reg. offset) to prevent it.",
    show: async (h) => { await h.choosePreset("eps-indi-b"); h.setView("blink"); h.openAdvanced(true); } },
  { title: "Check before you report", tag: "tip",
    text: "Watch one quarter of the image at a time. Then check SIMBAD and CatWISE for a known object, and SkyBoT for asteroids. Most one-pass events are asteroids.",
    show: async (h) => { await h.choosePreset("wise-0855"); h.setView("changes"); const e = h.state.events[0]; if (e) h.selectEvent(e.id); } },
];

export function renderGuide(box, h) {
  box.replaceChildren(...CARDS.map((c) => el("article", {},
    el("span", { class: `badge tag ${c.tag === "real" ? "badge-ok" : c.tag === "fake" ? "badge-warn" : "badge-new"}`, text: c.tag === "real" ? "Real" : c.tag === "fake" ? "Fake / artefact" : "Tip" }),
    el("h3", { text: c.title }),
    c.img ? el("img", { src: c.img, alt: `${c.title}: animated example`, loading: "lazy" }) : null,
    el("p", { text: c.text }),
    el("button", { type: "button", class: "primary", text: "Show me", onclick: async () => { h.closeGuide(); await c.show(h); document.getElementById("viewer").scrollIntoView({ block: "start" }); } }))));
}
