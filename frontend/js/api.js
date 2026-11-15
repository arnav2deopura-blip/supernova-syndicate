// Keep the frontend/backend boundary here. Never substitute synthetic data for a failed real search.
export const API_BASE = 'http://localhost:8000';
const isDemo = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('mock');
export class ApiError extends Error {
  constructor(message, code = 'upstream_unavailable') {super(message); this.code = code;}
}
const aborted = signal => {if(signal?.aborted) throw new DOMException('Cancelled', 'AbortError');};
async function getJSON(url, {signal} = {}) {
  aborted(signal);
  let response;
  try {response = await fetch(url, {signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(20000)])});}
  catch(e) {
    if(signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    throw new ApiError(e.name === 'TimeoutError' ? 'The data service took too long to respond. Please retry.' : 'The data service is unavailable. Check your connection or try a saved example target.');
  }
  let data;
  try {data = await response.json();} catch {throw new ApiError('The data service returned an unreadable response. Please retry.', 'invalid_response');}
  if (!response.ok) throw new ApiError(data.message || `No result is available (HTTP ${response.status}).`, data.error || (response.status === 404 ? 'not_found' : 'upstream_unavailable'));
  return {data, status:response.status};
}
const pause = (ms, signal) => new Promise((resolve,reject) => {
  aborted(signal);
  const done = () => {signal?.removeEventListener('abort',cancel); resolve();};
  const timer = setTimeout(done,ms);
  const cancel = () => {clearTimeout(timer); reject(new DOMException('Cancelled','AbortError'));};
  signal?.addEventListener('abort',cancel,{once:true});
});
async function live(endpoint, query, options) {
  let url = `${API_BASE}/api/${endpoint}?${new URLSearchParams(Object.entries(query).filter(([,v])=>v !== undefined && v !== null))}`;
  const deadline = Date.now()+15*60*1000;
  let {data,status} = await getJSON(url,options);
  while(status === 202 || data?.job_id) {
    aborted(options.signal);
    if(Date.now()>deadline) throw new ApiError('Preparation is taking longer than expected. Try this region again later; the server may still be preparing it.');
    options.onProgress?.(data);
    if(data.state === 'error') throw new ApiError(data.message || 'The requested observations could not be prepared.',data.error);
    if(data.state === 'done') {
      if(!data.result?.result_url) throw new ApiError('The completed request has no result URL.', 'invalid_response');
      url = data.result.result_url;
    } else {
      await pause(1000,options.signal);
      url = data.status_url || `${API_BASE}/api/jobs/${encodeURIComponent(data.job_id)}`;
    }
    ({data,status} = await getJSON(url,options));
  }
  return tag(data,'live','Live SPHEREx data');
}
function tag(data,kind,label) {return {...data,_provenance:{kind,label}};}
const separationRA = (a,b) => Math.abs(((a-b+540)%360)-180);
export function matchesSavedField(data,q) {
  return Number.isFinite(data.ra) && Number.isFinite(data.dec) && separationRA(data.ra,Number(q.ra)) < 0.00001 && Math.abs(data.dec-Number(q.dec)) < 0.00001 && (!q.band || data.band === q.band) && (q.fov === undefined || Math.abs(data.fov-Number(q.fov))<0.00001);
}
async function saved(endpoint,q,options) {
  if(!options.preset || !/^[a-z0-9-]+$/.test(options.preset)) throw new ApiError('No saved observations match this query.','not_found');
  const name = endpoint === 'frames' ? `frames_matched_${q.band}` : endpoint === 'spectrum' ? `spectrum_${q.det}` : endpoint;
  const {data} = await getJSON(`precomputed/${options.preset}/${name}.json`,options);
  if(endpoint === 'frames' && (!matchesSavedField(data,q) || data.matched !== true)) throw new ApiError('The saved field does not match those coordinates, size, band, and matched wavelengths. A live backend is needed for this query.','not_found');
  if(endpoint === 'spectrum' && !matchesSavedField(data,{ra:q.ra,dec:q.dec})) throw new ApiError('There is no saved spectrum for this pixel. Connect the backend to inspect a new position.','not_found');
  return tag(data,'precomputed','Saved SPHEREx observations');
}
async function call(endpoint,q,options = {}) {
  aborted(options.signal);
  if(isDemo()) {
    const {data} = await getJSON(`mock/${endpoint}.json`,options);
    return tag(data,'mock','Synthetic demo · not real observations');
  }
  if(options.savedOnly) return saved(endpoint,q,options);
  if(options.preferSaved && options.preset) {
    try {return await saved(endpoint,q,options);} catch(e) {if(options.signal?.aborted) throw e;}
  }
  try {return await live(endpoint,q,options);}
  catch(e) {
    if(options.signal?.aborted || ['bad_request','not_found','invalid_response'].includes(e.code)) throw e;
    if(options.preset) {
      try {return await saved(endpoint,q,options);} catch { /* report the live failure */ }
    }
    throw e;
  }
}
async function arrayData(value,options) {
  if(Array.isArray(value)) return value;
  if(typeof value !== 'string') throw new ApiError('An image array is missing.', 'invalid_response');
  const url = new URL(value,location.href);
  const response = await fetch(url,{signal:AbortSignal.any([...(options.signal ? [options.signal] : []),AbortSignal.timeout(30000)])});
  if(!response.ok) throw new ApiError('An image or noise-map file is unavailable. Please retry.', 'invalid_response');
  if(url.pathname.endsWith('.bin')) {
    const buffer = await response.arrayBuffer();
    if(buffer.byteLength%4) throw new ApiError('An image file has an invalid size.','invalid_response');
    const view = new DataView(buffer);
    return Array.from({length:buffer.byteLength/4},(_,i)=>{const v=view.getFloat32(i*4,true);return Number.isFinite(v)?v:null;});
  }
  return response.json();
}
export function validateFrames(response) {
  const wcs=response?.wcs;
  if(!wcs || !Number.isInteger(wcs.width) || !Number.isInteger(wcs.height) || wcs.width<1 || wcs.height<1 || !Number.isFinite(wcs.center_ra) || wcs.center_ra < 0 || wcs.center_ra >= 360 || !Number.isFinite(wcs.center_dec) || Math.abs(wcs.center_dec) > 90 || !Number.isFinite(wcs.pixel_scale_arcsec) || wcs.pixel_scale_arcsec <= 0) throw new ApiError('The observations have missing or invalid sky coordinates.','invalid_response');
  if(!Array.isArray(response.frames) || !response.frames.length) throw new ApiError('No observation periods are available for this region and band. Try another band or a nearby region.','not_found');
  for(const f of response.frames) {
    if(!f || typeof f !== 'object' || (f.mjd_mean != null && !Number.isFinite(f.mjd_mean))) throw new ApiError('An observation has missing or invalid metadata.','invalid_response');
    if(!Array.isArray(f.data) || f.data.length!==wcs.width*wcs.height || f.width!==wcs.width || f.height!==wcs.height || !Number.isFinite(f.mjd_start) || !Number.isFinite(f.mjd_end) || f.mjd_end < f.mjd_start) throw new ApiError('An observation has an invalid image size or time range.','invalid_response');
    if(!f.data.some(Number.isFinite)) throw new ApiError('An observation contains no usable pixels. Try a different band or region.','not_found');
    if(f.data.some(v=>v!==null && !Number.isFinite(v))) throw new ApiError('An observation contains invalid pixel values.','invalid_response');
  }
  response.frames.sort((a,b)=>(a.mjd_mean??a.mjd_start)-(b.mjd_mean??b.mjd_start));
  return response;
}
export const api = {
  resolve: (name,options={}) => call('resolve',{name},options),
  async frames(q,options={}) {
    const response=await call('frames',{...q,matched:1,async:1},options);
    if(!Array.isArray(response.frames) || response.frames.some(f=>!f || typeof f!=='object')) throw new ApiError('No valid image frames were returned.','invalid_response');
    await Promise.all(response.frames.map(async f=>{
      f.data=await arrayData(f.data,options);
      if(f.noise) {
        try {f.noiseData=await arrayData(f.noise,options);if(f.noiseData.length!==f.data.length) throw new Error('Noise-map dimensions do not match.');}
        catch(e) {if(options.signal?.aborted) throw e;delete f.noiseData;f._noiseError=true;}
      }
    }));
    validateFrames(response);
    if(response._provenance.kind!=='mock' && (response.matched!==true || !response.matched_channels?.length)) throw new ApiError('The service did not return wavelength-matched observations. A reliable brightness comparison is unavailable.','invalid_response');
    return response;
  },
  overlay:(q,options={})=>call('overlay',{...q,cat:'gaia'},options),
  spectrum:(q,options={})=>call('spectrum',{...q,async:1},options)
};
