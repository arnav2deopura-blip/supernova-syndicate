// Skippable, keyboard-accessible introduction. No external libraries or HTML injection.

const STORAGE_FALLBACK = new Map();
let tourCount = 0;

export const DEFAULT_TOUR_STEPS = [
  {
    selector: ".search-tabs",
    title: "Start with a patch of sky",
    body: "Choose how to explore: freely move around the sky map, search for an object by name, or enter its sky coordinates. All three lead to the same comparison workspace.",
  },
  {
    selector: "#name",
    title: "Names and sky coordinates",
    body: "An object name is the easiest starting point. Right ascension (RA) and declination (Dec) describe a position on the sky, like longitude and latitude on Earth. RA runs from 0 to 360 degrees; Dec runs from −90 to +90 degrees.",
  },
  {
    selector: "#fov",
    title: "Choose how much sky to compare",
    body: "Field of view (FOV) is the width of your selected patch, measured in degrees. A smaller field helps you inspect one object. The detector band chooses an infrared wavelength range; compare observation periods within the same band.",
  },
  {
    selector: ".player",
    title: "Watch for something that changes",
    body: "Each frame combines observations from one period, called an epoch. Play blinks between epochs. Pause and step through them to look for a star that shifts position or changes brightness. A visual change is a candidate to investigate, not a confirmed discovery.",
  },
  {
    selector: "#mode",
    title: "Reveal changes with a difference image",
    body: "Difference subtracts the first epoch from the last. In the difference colour map, red means brighter and blue means fainter. A moving source can leave a red-and-blue pair. Different sampled wavelengths, image alignment, saturation, and noise can also create residuals.",
  },
  {
    selector: "#spectrum",
    title: "Look at the light, wavelength by wavelength",
    body: "Click the comparison image to request a spectrum at that position. It shows brightness at different infrared wavelengths. Spectrum flux is measured in microjanskys (µJy); image surface brightness uses MJy/sr. These are different quantities. Flagged or missing measurements should not be treated as reliable detections.",
  },
  {
    selector: "#advanced",
    title: "Inspect the evidence",
    body: "Open Advanced for observation dates, pixel scale, quality information, and calculations supported by the returned data. Unknown means the required measurement is missing. Check uncertainty and wavelength matching before interpreting a change. You can reopen this tour any time.",
  },
];

function readStored(key) {
  try { return localStorage.getItem(key) || STORAGE_FALLBACK.get(key); }
  catch { return STORAGE_FALLBACK.get(key); }
}

function writeStored(key, value) {
  STORAGE_FALLBACK.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* Private/blocked storage: keep a session preference. */ }
}

function resolveElement(value) {
  if (typeof value !== "string") return value || null;
  try { return document.querySelector(value); } catch { return null; }
}

function button(label, className) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

/**
 * @param {object} options
 * @param {Element|string} options.trigger Reopens the walkthrough, even after it was skipped.
 * @param {Array<{selector?: string|Element, title: string, body: string|string[], beforeShow?: Function}>} [options.steps]
 * @param {boolean} [options.autoStart=true] Offer the tour on a visitor's first visit.
 * @param {string} [options.storageKey="spherex-tour-v1"] Bump this to offer a revised tour.
 * @returns {{start: () => Promise<void>, destroy: () => void}}
 */
export function initTutorial({ trigger, steps = DEFAULT_TOUR_STEPS, autoStart = true, storageKey = "spherex-tour-v1" } = {}) {
  const tourSteps = Array.isArray(steps) ? steps.filter((step) => step && step.title) : [];
  const triggerElement = resolveElement(trigger);
  const id = `sky-tour-${++tourCount}`;
  const backdrop = document.createElement("div");
  backdrop.className = "tour-backdrop";
  backdrop.hidden = true;
  const dialog = document.createElement("div");
  dialog.className = "tour-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-body`);
  dialog.tabIndex = -1;

  const progress = document.createElement("p");
  progress.className = "tour-progress";
  progress.setAttribute("aria-live", "polite");
  progress.setAttribute("aria-atomic", "true");
  const title = document.createElement("h2");
  title.id = `${id}-title`;
  const body = document.createElement("div");
  body.id = `${id}-body`;
  body.className = "tour-body";
  const actions = document.createElement("div");
  actions.className = "tour-actions";
  const skip = button("Skip tour", "tour-skip");
  const back = button("Back", "tour-back");
  const next = button("Next", "tour-next primary-button");
  actions.append(skip, back, next);
  dialog.append(progress, title, body, actions);
  backdrop.append(dialog);
  document.body.append(backdrop);

  let active = false;
  let destroyed = false;
  let index = 0;
  let changing = false;
  let generation = 0;
  let highlighted = null;
  let targetAlreadyHighlighted = false;
  let returnFocus = null;
  let autoTimer = null;
  const inertState = new Map();

  function clearHighlight() {
    if (highlighted && !targetAlreadyHighlighted) highlighted.classList.remove("tour-highlight");
    highlighted = null;
    targetAlreadyHighlighted = false;
  }

  function setBackgroundInert(value) {
    if (value) {
      for (const child of document.body.children) {
        if (child === backdrop) continue;
        inertState.set(child, child.inert);
        child.inert = true;
      }
    } else {
      for (const [child, original] of inertState) child.inert = original;
      inertState.clear();
    }
  }

  function finish(status, restoreFocus = true) {
    if (!active) return;
    active = false;
    changing = false;
    generation++;
    clearHighlight();
    backdrop.hidden = true;
    document.body.classList.remove("tour-open");
    setBackgroundInert(false);
    if (status) writeStored(storageKey, status);
    if (restoreFocus) {
      const element = returnFocus?.isConnected ? returnFocus : triggerElement;
      if (element && !element.inert) element.focus({ preventScroll: true });
    }
  }

  async function showStep(newIndex) {
    if (!active || destroyed || changing) return;
    const currentGeneration = ++generation;
    changing = true;
    dialog.setAttribute("aria-busy", "true");
    back.disabled = true;
    next.disabled = true;
    clearHighlight();
    index = Math.max(0, Math.min(tourSteps.length - 1, newIndex));
    const step = tourSteps[index];
    // Update the text immediately, including when a feature takes time to open.
    title.textContent = step.title;
    progress.textContent = `Step ${index + 1} of ${tourSteps.length}`;
    body.replaceChildren();
    const paragraphs = Array.isArray(step.body) ? step.body : [step.body];
    for (const text of paragraphs) {
      if (text == null) continue;
      const paragraph = document.createElement("p");
      paragraph.textContent = String(text);
      body.append(paragraph);
    }
    try {
      if (typeof step.beforeShow === "function") await step.beforeShow();
    } catch {
      // A map/network failure must never trap someone in the introduction.
    }
    if (!active || destroyed || currentGeneration !== generation) return;

    const target = resolveElement(step.selector);
    if (target && target.getClientRects().length) {
      highlighted = target;
      targetAlreadyHighlighted = target.classList.contains("tour-highlight");
      target.classList.add("tour-highlight");
      target.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    }
    changing = false;
    dialog.removeAttribute("aria-busy");
    back.disabled = index === 0;
    next.disabled = false;
    next.textContent = index === tourSteps.length - 1 ? "Start exploring" : "Next";
    skip.textContent = index === tourSteps.length - 1 ? "Close tour" : "Skip tour";
    dialog.focus({ preventScroll: true });
  }

  async function start() {
    clearTimeout(autoTimer);
    if (destroyed || !tourSteps.length) return;
    if (active) {
      dialog.focus({ preventScroll: true });
      return;
    }
    active = true;
    returnFocus = document.activeElement;
    backdrop.hidden = false;
    document.body.classList.add("tour-open");
    setBackgroundInert(true);
    dialog.focus({ preventScroll: true });
    await showStep(0);
  }

  function onKeydown(event) {
    if (!active) return;
    // Keep the app's global Space/arrow shortcuts from changing the sky behind the tour.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      finish("skipped");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [skip, back, next].filter((element) => !element.disabled && !element.hidden);
    const first = focusable[0];
    const last = focusable.at(-1);
    const focused = document.activeElement;
    if (event.shiftKey && (focused === first || focused === dialog || !dialog.contains(focused))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (focused === last || focused === dialog || !dialog.contains(focused))) {
      event.preventDefault();
      first?.focus();
    }
  }

  function onFocus(event) {
    if (active && !dialog.contains(event.target)) dialog.focus({ preventScroll: true });
  }

  function onTrigger() { void start(); }
  function onSkip() { finish(index === tourSteps.length - 1 ? "completed" : "skipped"); }
  function onBack() { void showStep(index - 1); }
  function onNext() {
    if (index === tourSteps.length - 1) finish("completed");
    else void showStep(index + 1);
  }
  function offerTour() {
    if (destroyed || active || readStored(storageKey)) return;
    if (document.visibilityState === "hidden") return;
    void start();
    document.removeEventListener("visibilitychange", offerTour);
  }

  triggerElement?.addEventListener("click", onTrigger);
  skip.addEventListener("click", onSkip);
  back.addEventListener("click", onBack);
  next.addEventListener("click", onNext);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("focusin", onFocus, true);
  if (autoStart && !readStored(storageKey)) {
    autoTimer = setTimeout(offerTour, 500);
    document.addEventListener("visibilitychange", offerTour);
  }

  function destroy() {
    if (destroyed) return;
    clearTimeout(autoTimer);
    finish(null);
    destroyed = true;
    generation++;
    triggerElement?.removeEventListener("click", onTrigger);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("visibilitychange", offerTour);
    backdrop.remove();
  }

  return { start, destroy };
}
