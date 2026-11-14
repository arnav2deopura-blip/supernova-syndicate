// Spectrum and light-curve chart (plain canvas, no library). Owner: C.

const EPOCH_COLORS = ["#6cb4ff", "#ffb547", "#ff6b6b", "#7ee787", "#d2a8ff", "#f0f0f0"];

export function drawSpectrum(canvas, points) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, pad = { l: 44, r: 10, t: 10, b: 28 };
  ctx.clearRect(0, 0, W, H);
  ctx.font = "11px system-ui";
  ctx.fillStyle = "#8b95a7";

  const pts = (points || []).filter((p) => !p.flagged);
  if (!pts.length) {
    ctx.fillText("Click a star to see its spectrum", pad.l, H / 2);
    return;
  }
  const xs = pts.map((p) => p.wavelength_um), ys = pts.map((p) => p.flux);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(0, Math.min(...ys)), y1 = Math.max(...ys) * 1.05 || 1;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (y) => H - pad.b - ((y - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  ctx.strokeStyle = "#2a3550";
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b);
  ctx.stroke();
  ctx.fillText(`${x0.toFixed(2)} µm`, pad.l, H - 10);
  ctx.fillText(`${x1.toFixed(2)} µm`, W - pad.r - 50, H - 10);
  ctx.fillText(`${Math.round(y1)}`, 4, pad.t + 8);
  ctx.fillText("µJy", 4, pad.t + 22);

  const epochs = [...new Set(pts.map((p) => p.epoch_label))];
  pts.forEach((p) => {
    ctx.fillStyle = EPOCH_COLORS[epochs.indexOf(p.epoch_label) % EPOCH_COLORS.length];
    ctx.fillRect(X(p.wavelength_um) - 1.5, Y(p.flux) - 1.5, 3, 3);
  });
  epochs.forEach((e, i) => {
    ctx.fillStyle = EPOCH_COLORS[i % EPOCH_COLORS.length];
    ctx.fillText(e, W - pad.r - 30, pad.t + 10 + i * 13);
  });
}
