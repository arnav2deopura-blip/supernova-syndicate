// ICRS query validation, independent of the DOM.
export function parseCoord(text, isRA) {
  const value = String(text).trim().replaceAll('−', '-');
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) && (isRA ? n >= 0 && n < 360 : Math.abs(n) <= 90) ? n : NaN;
  }
  const clean = value.replace(/[hHdD°]/g, ':').replace(/[mM′']/g, ':').replace(/[sS″"]/g, '').trim();
  if (!/^[+-]?\d+(?:\.\d+)?(?:[\s:]+\d+(?:\.\d+)?){1,2}$/.test(clean)) return NaN;
  const parts = clean.split(/[\s:]+/).map(Number);
  const [major, minute, second = 0] = parts;
  if (minute >= 60 || second >= 60 || (isRA && (major < 0 || value.startsWith('-') || major >= 24))) return NaN;
  const sign = value.startsWith('-') ? -1 : 1;
  const result = sign * (Math.abs(major) + minute / 60 + second / 3600) * (isRA ? 15 : 1);
  return isRA ? (result >= 0 && result < 360 ? result : NaN) : (Math.abs(result) <= 90 ? result : NaN);
}
export function validateQuery({ra, dec, fov, band}) {
  if (!Number.isFinite(ra) || ra < 0 || ra >= 360) throw new Error('Enter RA from 0 to less than 360 degrees, or hours:minutes:seconds from 00:00:00 to less than 24:00:00.');
  if (!Number.isFinite(dec) || Math.abs(dec) > 90) throw new Error('Enter Dec from −90 to +90 degrees. Minutes and seconds must be less than 60.');
  if (!Number.isFinite(Number(fov)) || Number(fov) <= 0 || Number(fov) > 0.5) throw new Error('Choose a region greater than 0° and no wider than 0.5°. Zoom in or select a smaller region.');
  if (!/^D[1-6]$/.test(band)) throw new Error('Choose an infrared detector band from D1 to D6.');
  return {ra, dec, fov:Number(fov), band};
}
export function mjdDate(mjd) {
  if (!Number.isFinite(mjd)) return 'Unknown';
  return new Date((mjd - 40587) * 86400000).toISOString().slice(0,10);
}
