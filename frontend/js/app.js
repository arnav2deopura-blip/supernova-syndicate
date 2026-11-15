import {api} from './api.js';
import {Player} from './player.js';
import {composeFrame,draw} from './render.js';
import {drawOverlay,pixelToSky} from './overlays.js';
import {drawSpectrum} from './spectrum.js';
import {parseCoord,validateQuery,mjdDate} from './coordinates.js';
import {initSkyMap} from './skymap.js';
import {initTutorial} from './tutorial.js';
import {renderAdvanced} from './advanced.js';

const PRESETS = [
  {slug:'barnards-star',label:'Barnard’s Star',name:"Barnard's Star",band:'D2',story:'a fast mover',aliases:['barnard','barnards star']},
  {slug:'eps-indi-b',label:'ε Indi B',name:'eps Indi B',band:'D3',story:'a faint companion',aliases:['epsilon indi b','eps indi b','ε indi b']},
  {slug:'wise-0855',label:'WISE 0855',name:'WISE J085510.83-071442.5',band:'D6',story:'a cold neighbour',aliases:['wise 0855','wise 0855-0714','wise j085510.83-071442.5']},
  {slug:'rw-aur',label:'RW Aur',name:'RW Aur',band:'D2',story:'a variable star',aliases:['rw aur','rw aurigae']},
  {slug:'r-dra',label:'R Dra',name:'R Dra',band:'D2',story:'a pulsating star',aliases:['r dra','r draconis']}
];
const $ = id=>document.getElementById(id);
const normalise = value=>value.toLowerCase().replace(/[’']/g,'').replace(/−/g,'-').trim().replace(/\s+/g,' ');
const findPreset = name=>PRESETS.find(p=>[p.name,p.label,...p.aliases].some(a=>normalise(a)===normalise(name)));
const state={frames:null,sources:null,spectrum:null,resolved:null,selectedPixel:null,source:null,preset:null,index:0,searchMode:'name',serial:0,controller:null,spectrumController:null};
let allLimits=[];
const player=new Player(i=>{state.index=i;render();});
function message(id,text,error=false) {const el=$(id);el.textContent=text;el.hidden=!text;el.classList.toggle('error',error);}
function showError(text) {message('query-error',text,true);}
const sky=initSkyMap({onCompare:q=>search({q}),onError:showError});
function switchSearch(mode,focus=false) {
  state.searchMode=mode;
  document.querySelectorAll('[data-search]').forEach(button=>{const selected=button.dataset.search===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;$(`panel-${button.dataset.search}`).hidden=!selected;if(selected&&focus)button.focus();});
  message('query-error','');
  $('fov').disabled=mode==='space';
  if(mode==='space') sky.open();
}
document.querySelectorAll('[data-search]').forEach(button=>{
  button.addEventListener('click',()=>switchSearch(button.dataset.search));
  button.addEventListener('keydown',event=>{
    const modes=['name','space','coordinates'];const i=modes.indexOf(button.dataset.search);
    let next;
    if(event.key==='ArrowRight')next=(i+1)%3;if(event.key==='ArrowLeft')next=(i+2)%3;if(event.key==='Home')next=0;if(event.key==='End')next=2;
    if(next!==undefined){event.preventDefault();switchSearch(modes[next],true);}
  });
});
function enableViewer(enabled) {
  for(const id of ['play','previous-frame','next-frame','mode','show-overlay','target-spectrum'])$(id).disabled=!enabled;
}
function clearResults() {
  state.frames=state.sources=state.spectrum=state.resolved=state.selectedPixel=state.source=null;
  allLimits=[];clearInterval(player.timer);player.count=0;
  for(const id of ['image','overlay','spectrum']){const c=$(id);c.getContext('2d').clearRect(0,0,c.width,c.height);}
  $('viewer-empty').hidden=false;$('viewer-empty').firstChild.textContent='No comparison loaded';
  $('data-source').textContent='No observations loaded';$('frame-label').textContent='—';
  $('target-summary').textContent='Choose a target to begin.';
  $('spectrum-status').textContent='No spectrum requested.';$('overlay-status').textContent='';
  document.querySelector('#meta tbody').replaceChildren();
  message('banner','');message('comparison-notice','');enableViewer(false);updateAdvanced();
}
function updateAdvanced(error) {renderAdvanced($('science-details'),{frames:state.frames,spectrum:state.spectrum,source:state.source,selectedPixel:state.selectedPixel,resolved:state.resolved,error});}
function progress(job) {
  $('loading-title').textContent=job.message || job.stage || 'Preparing observations…';
  if(Number.isFinite(job.total)&&job.total>0){$('load-progress').max=job.total;$('load-progress').value=Math.min(job.done||0,job.total);}else $('load-progress').removeAttribute('value');
}
function frameTable(frames) {
  const body=document.querySelector('#meta tbody');body.replaceChildren();
  for(const f of frames){
    const row=document.createElement('tr');
    const flags=f.target_flags;
    const quality=Array.isArray(flags)?(flags.length?flags.join(', '):'No target flags reported'):'Unknown';
    for(const value of [f.epoch_label,`${mjdDate(f.mjd_start)} – ${mjdDate(f.mjd_end)}`,Number.isFinite(f.n_exposures)?f.n_exposures:'Unknown',Number.isFinite(f.flag_fraction)?`${(f.flag_fraction*100).toFixed(2)}%`:'Unknown',quality]){const td=document.createElement('td');td.textContent=value;row.append(td);}
    body.append(row);
  }
}
async function search({q,name,preset,preferSaved=false}={}) {
  if(q){try{q=validateQuery(q);}catch(e){showError(e.message);return;}}
  const serial=++state.serial;
  state.controller?.abort();state.spectrumController?.abort();state.controller=new AbortController();
  const signal=state.controller.signal;
  clearResults();message('query-error','');
  state.preset=preset?.slug||null;
  $('loading').hidden=false;$('load-progress').removeAttribute('value');$('loading-title').textContent=name?'Finding this object…':'Finding observations…';
  $('comparison').setAttribute('aria-busy','true');
  document.querySelectorAll('#presets button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.slug===state.preset)));
  let resolved;
  try {
    if(name){
      resolved=await api.resolve(name,{signal,preset:state.preset,preferSaved});
      if(!Number.isFinite(resolved.ra)||!Number.isFinite(resolved.dec)) throw new Error('That name could not be resolved to sky coordinates. Try a recognised catalogue name or search by coordinates.');
      q=validateQuery({ra:resolved.ra,dec:resolved.dec,fov:Number($('fov').value),band:$('band').value});
    }
    $('loading-title').textContent='Preparing wavelength-matched observations…';
    const response=await api.frames(q,{signal,preset:state.preset,preferSaved,onProgress:job=>{if(serial===state.serial)progress(job);}});
    if(serial!==state.serial)return;
    state.frames=response;state.source=response._provenance;state.resolved=resolved;
    allLimits=response.frames.flatMap(f=>f.data);
    const actual={ra:response.ra,dec:response.dec,fov:response.fov,band:response.band};
    $('ra').value=actual.ra;$('dec').value=actual.dec;
    sky.centre(actual.ra,actual.dec);
    $('viewer-empty').hidden=true;
    $('data-source').textContent=state.source.label;
    const title=state.source.kind==='mock'?'Synthetic example field':(preset?.label||name||'Selected sky region');
    $('comparison-title').textContent=title;
    $('target-summary').textContent=`RA ${actual.ra.toFixed(6)}° · Dec ${actual.dec.toFixed(6)}° · ${actual.band} · ${actual.fov.toFixed(4)}° square · ${response.frames.length} observation periods`;
    const warnings=[];
    if(state.source.kind==='precomputed')warnings.push(`Showing saved real SPHEREx observations${response.release?` (${response.release})`:''}. This is a prepared example, not a live archive refresh.`);
    if(state.source.kind==='mock')warnings.push('DEMO: these pixels are synthetic sample data, not observations of your query. Exit demo mode by removing ?mock=1 from the URL.');
    if(response.frames.some(f=>f._noiseError))warnings.push('Some noise maps are unavailable. Affected uncertainty measurements are Unknown.');
    message('banner',warnings.join(' '));
    if(response.frames.length<2)message('comparison-notice','Only one observation period is available. A change comparison needs at least two; try another region or band.');
    else if(response.frames.some(f=>f.target_flagged || f.target_flags?.includes('OVERFLOW')))message('comparison-notice','Target quality warning: some measurements are flagged, including possible saturation. Inspect Advanced analysis before interpreting a change.');
    frameTable(response.frames);enableViewer(true);
    $('play').disabled=response.frames.length<2;
    $('mode').querySelector('[value="diff"]').disabled=response.frames.length<2;
    $('mode').querySelector('[value="sum"]').disabled=response.frames.length<2;
    if(response.frames.length<2)$('mode').value='blink';
    player.playing=!matchMedia('(prefers-reduced-motion: reduce)').matches;
    player.load(response.frames.length);$('play').textContent=player.playing?'Pause':'Play';
    updateAdvanced();
    const url=new URL(location.href);for(const[k,v]of Object.entries(actual))url.searchParams.set(k,v);
    if(state.preset)url.searchParams.set('target',state.preset);else url.searchParams.delete('target');
    history.replaceState(null,'',url);
    // Load catalogue markers only if requested; they can be much slower than cached images.
    if($('show-overlay').checked)loadOverlay(serial);
  } catch(e) {
    if(signal.aborted || serial!==state.serial)return;
    showError(e.message || 'This search did not return observations. Try another object, band, or region.');
    $('target-summary').textContent='No observations returned for this query.';
    $('comparison-title').textContent='No comparison available';
    updateAdvanced(e.message);
  } finally {
    if(serial===state.serial){$('loading').hidden=true;$('comparison').removeAttribute('aria-busy');}
  }
}
async function choosePreset(p) {
  switchSearch('name');$('name').value=p.name;$('band').value=p.band;$('fov').value='0.1';
  await search({name:p.name,preset:p,preferSaved:true});
}
for(const p of PRESETS){const b=document.createElement('button');b.type='button';b.dataset.slug=p.slug;b.setAttribute('aria-pressed','false');b.textContent=p.label;const small=document.createElement('small');small.textContent=p.story;b.append(small);b.addEventListener('click',()=>choosePreset(p));$('presets').append(b);}
$('target-form').addEventListener('submit',event=>{
  event.preventDefault();
  if(state.searchMode==='name'){
    const name=$('name').value.trim();if(!name){showError('Enter an object name, such as Barnard’s Star, or choose an example below.');$('name').focus();return;}
    search({name,preset:findPreset(name),preferSaved:true});
  } else if(state.searchMode==='coordinates')search({q:{ra:parseCoord($('ra').value,true),dec:parseCoord($('dec').value,false),fov:Number($('fov').value),band:$('band').value}});
});
$('cancel-load').addEventListener('click',()=>{state.controller?.abort();state.serial++;$('loading').hidden=true;$('comparison').removeAttribute('aria-busy');showError('Search cancelled. Any preparation already started on the server may continue. Choose another target when you’re ready.');});
function render() {
  if(!state.frames)return;
  const {frames,wcs}=state.frames;const mode=$('mode').value;const data=composeFrame(frames,state.index,mode);
  draw($('image'),data,wcs.width,wcs.height,{stretch:$('stretch').value,cmap:$('cmap').value,clip:Number($('clip').value),limitsFrom:mode==='blink'?allLimits:data,diverging:mode==='diff'});
  const f=frames[mode==='blink'?state.index:frames.length-1];
  $('frame-label').textContent=mode==='blink'?`${f.epoch_label} · ${mjdDate(f.mjd_mean??(f.mjd_start+f.mjd_end)/2)} · ${state.index+1}/${frames.length}`:mode==='diff'?`${frames.at(-1).epoch_label} − ${frames[0].epoch_label}`:'All periods summed';
  drawOverlay($('overlay'),state.sources,wcs,f.epoch_label,{show:$('show-overlay').checked});
  $('mode-help').textContent={blink:'Blink: watch for a point of light that moves or changes brightness while its neighbours stay steady.',diff:'Difference: red is a positive residual (brighter in the last period); blue is negative. A red/blue pair can indicate motion. Noise and artefacts also leave residuals.',sum:'Sum: add all periods together to see shared structure. A moving source can blur across the combined image.'}[mode];
}
async function loadOverlay(serial=state.serial) {
  if(!state.frames)return;
  if(state.sources){render();return;}
  const f=state.frames;$('overlay-status').textContent='Loading Gaia reference stars…';
  try{
    const result=await api.overlay({ra:f.ra,dec:f.dec,fov:f.fov},{signal:state.controller.signal,preset:state.source.kind==='precomputed'?state.preset:null,savedOnly:state.source.kind==='precomputed'});
    if(serial!==state.serial)return;
    state.sources=Array.isArray(result.sources)?result.sources:[];
    $('overlay-status').textContent=state.sources.length?`${state.sources.length} Gaia catalogue stars. Gaia does not include every infrared source.`:'No Gaia catalogue stars were returned for this field.';render();
  }catch(e){if(serial!==state.serial||state.controller.signal.aborted)return;state.sources=null;$('overlay-status').textContent=`Gaia overlay unavailable: ${e.message}`;render();}
}
async function inspectPixel(x,y,atTarget=false) {
  if(!state.frames)return;
  const serial=state.serial;state.spectrumController?.abort();state.spectrumController=new AbortController();
  const signal=state.spectrumController.signal;const f=state.frames;
  x=Math.max(0,Math.min(f.wcs.width-1,Math.floor(x)));y=Math.max(0,Math.min(f.wcs.height-1,Math.floor(y)));
  state.selectedPixel={x,y};state.spectrum=null;updateAdvanced();drawSpectrum($('spectrum'),[]);
  const position=atTarget?{ra:f.ra,dec:f.dec}:pixelToSky(x+.5,y+.5,f.wcs);
  $('spectrum-status').textContent=`Preparing spectrum at RA ${position.ra.toFixed(6)}°, Dec ${position.dec.toFixed(6)}°…`;
  const q={...position,det:f.band};
  // A named target's proper motion applies only to that target, not an arbitrary clicked star.
  if(atTarget&&state.resolved)for(const k of ['pmra','pmdec','epoch'])if(Number.isFinite(state.resolved[k]))q[k]=state.resolved[k];
  try{
    const result=await api.spectrum(q,{signal,preset:atTarget&&state.source.kind==='precomputed'?state.preset:null,savedOnly:state.source.kind==='precomputed',onProgress:job=>{if(!signal.aborted)$('spectrum-status').textContent=job.message||'Preparing spectrum…';}});
    if(serial!==state.serial||signal.aborted)return;
    state.spectrum=result;const points=(Array.isArray(result.points)?result.points:[]).filter(p=>p.flagged===false&&p.fit!=='failed'&&Number.isFinite(p.wavelength_um)&&Number.isFinite(p.flux)&&Number.isFinite(p.flux_err)&&p.flux_err>0);
    drawSpectrum($('spectrum'),points);
    const excluded=(result.points?.length||0)-points.length;
    $('spectrum-status').textContent=points.length?`${points.length} usable measurements in ${f.band}, flux in µJy. ${excluded} flagged or invalid measurements excluded. Image pixel values use different units (MJy/sr).`:`No usable spectrum: ${excluded} measurements were flagged or invalid. Saturation or missing coverage may prevent reliable photometry.`;
    updateAdvanced();
  }catch(e){if(serial!==state.serial||signal.aborted)return;$('spectrum-status').textContent=`Spectrum unavailable: ${e.message}`;updateAdvanced();}
}
$('target-spectrum').addEventListener('click',()=>{if(state.frames)inspectPixel(state.frames.wcs.width/2,state.frames.wcs.height/2,true);});
$('image').addEventListener('click',event=>{if(!state.frames)return;const r=$('image').getBoundingClientRect();inspectPixel((event.clientX-r.left)/r.width*state.frames.wcs.width,(event.clientY-r.top)/r.height*state.frames.wcs.height);});
$('image').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('target-spectrum').click();}});
$('play').addEventListener('click',()=>{$('play').textContent=player.toggle()?'Pause':'Play';});
$('previous-frame').addEventListener('click',()=>player.step(-1));$('next-frame').addEventListener('click',()=>player.step(1));
$('speed').addEventListener('input',()=>{player.setSpeed(Number($('speed').value));$('speed-value').textContent=`${$('speed').value} frames/s`;});
for(const id of ['mode','stretch','cmap','clip'])$(id).addEventListener('input',()=>{$('clip-value').textContent=`${$('clip').value}%`;render();});
$('show-overlay').addEventListener('change',()=>{render();if($('show-overlay').checked)loadOverlay();});
window.addEventListener('resize',render);
$('advanced').addEventListener('toggle',()=>{if($('advanced').open)updateAdvanced();});
document.addEventListener('keydown',event=>{if(!state.frames||document.querySelector('.tour-open')||event.target.closest('input,select,button,textarea,summary,[role="dialog"]')||!$('comparison').contains(document.activeElement))return;if(event.key===' '){event.preventDefault();$('play').click();}if(event.key==='ArrowRight')player.step(1);if(event.key==='ArrowLeft')player.step(-1);});
initTutorial({trigger:$('help-tour'),steps:[
  {selector:'.intro',title:'Find changes, follow clues',body:'Compare the same patch of infrared sky at different times. A point that moves or changes brightness could be worth investigating. This tour takes about a minute; skip it at any time.'},
  {selector:'.search-tabs',title:'Three ways to start',body:'Use an object name, freely explore a reference sky map, or enter exact coordinates. Example targets use saved real SPHEREx observations so you can get started quickly.'},
  {selector:'#panel-name',title:'Search for an object',body:'Enter a recognised astronomical name. We resolve it to coordinates before loading its observations. Barnard’s Star is a useful example of a nearby star moving across the sky.',beforeShow:()=>switchSearch('name')},
  {selector:'#panel-space',title:'Explore and select',body:'Drag the map to move around and scroll or pinch to zoom. Choose Select a region, draw a small rectangle, then Compare selected sky. Regions must be no wider than 0.5°. The map is optical reference imagery; comparison images are infrared.',beforeShow:()=>switchSearch('space')},
  {selector:'#panel-coordinates',title:'What are RA and Dec?',body:'Right ascension (RA) and declination (Dec) locate a point on the sky, like longitude and latitude on Earth. RA accepts decimal degrees or hours:minutes:seconds. Dec accepts degrees or degrees:minutes:seconds.',beforeShow:()=>switchSearch('coordinates')},
  {selector:'.query-options',title:'Choose the size and infrared band',body:'Field of view is the width of your square patch in degrees. A smaller number gives a closer look. D1–D6 are infrared detector bands, not observation dates. Wavelength matching keeps the compared periods as similar in colour as possible.'},
  {selector:'#comparison',title:'Watch the same sky over time',body:'Each period combines several exposures. Blink alternates those periods; Pause and the arrows let you inspect them one by one. Difference subtracts the first from the last: a bright/dark pair can reveal motion.',beforeShow:()=>switchSearch('name')},
  {selector:'.side',title:'Read the signal carefully',body:'A spectrum measures brightness at different wavelengths. Click Inspect target to try it. Flags mark measurements affected by issues such as saturation. A whole field shifting together may be an alignment problem rather than many moving stars.'},
  {selector:'#advanced',title:'Go deeper when you need to',body:'Open Advanced analysis for dates, quality flags, wavelengths, noise maps, and calculated changes. MJy/sr describes image surface brightness; µJy describes fitted source flux. Unknown means the required information is missing. A large noise ratio alone does not confirm a discovery.',beforeShow:()=>{$('advanced').open=true;}},
  {selector:'#presets',title:'Start with a known story',body:'Try Barnard’s Star for motion or RW Aur for changing brightness. Look for a change, check the quality and nearby sources, then ask what could explain it. You can reopen this tour at the top of the page.',beforeShow:()=>{$('advanced').open=false;switchSearch('name');}}
]});
clearResults();
const params=new URLSearchParams(location.search);const preset=PRESETS.find(p=>p.slug===params.get('target'));
if(params.has('ra')&&params.has('dec')){
  $('band').value=/^D[1-6]$/.test(params.get('band'))?params.get('band'):'D2';
  const q={ra:parseCoord(params.get('ra'),true),dec:parseCoord(params.get('dec'),false),fov:Number(params.get('fov')||0.1),band:$('band').value};
  if([...$('fov').options].some(o=>Number(o.value)===q.fov))$('fov').value=String(q.fov);
  $('ra').value=params.get('ra');$('dec').value=params.get('dec');switchSearch('coordinates');
  search({q,preset,preferSaved:Boolean(preset)});
}else choosePreset(PRESETS[0]);
