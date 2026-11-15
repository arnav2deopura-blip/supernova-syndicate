// Aladin is a navigation reference. Only the backend supplies SPHEREx comparisons.
const ALADIN_SCRIPT = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.1/dist/aladin.js';
const SKY_SURVEY = 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color';
const SKY_SURVEY_MIRROR = 'https://skies.esac.esa.int/DSSColor';
async function referenceSurvey() {
  for(const root of [SKY_SURVEY,SKY_SURVEY_MIRROR]) {
    try {
      await Promise.all(['properties','Norder3/Allsky.jpg'].map(async path=>{
        const response=await fetch(`${root}/${path}`,{signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('Reference imagery unavailable.');
        await response.arrayBuffer();
      }));
      return root;
    }catch { /* Try the next documented HiPS mirror. */ }
  }
  throw new Error('Reference sky imagery is unavailable. Please retry, or search by object name or coordinates.');
}
let library;
function loadLibrary() {
  if (!library) library = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {library=null;reject(new Error('The reference map timed out. Check your connection and try again.'));},25000);
    import(ALADIN_SCRIPT).then(module=>{clearTimeout(timer);resolve(module.default);},()=>{clearTimeout(timer);library=null;reject(new Error('The reference sky map could not load. You can still search by object name or coordinates.'));});
  });
  return library;
}
export function initSkyMap({onCompare, onError}) {
  const $ = id => document.getElementById(id);
  let aladin, aladinAPI, loading = false, selection, outline;
  function displaySelection(ra, dec, fov) {
    selection = null;
    outline?.removeAll();
    $('map-compare').disabled = true;
    if (![ra,dec,fov].every(Number.isFinite) || fov <= 0 || fov > 0.5) {
      $('map-selection').textContent = 'That region is too large or outside the map. Zoom in and choose a square no wider than 0.5°.';
      onError($('map-selection').textContent);
      return;
    }
    selection = {ra, dec, fov, band:$('band').value};
    $('map-selection').textContent = `RA ${ra.toFixed(5)}° · Dec ${dec.toFixed(5)}° · ${fov.toFixed(4)}° square`;
    $('map-compare').disabled = false;
    // A circle marks the chosen centre; the text reports the actual square cutout size.
    if (aladinAPI?.graphicOverlay && aladinAPI?.circle) {
      outline?.removeAll();
      if (!outline) {outline = aladinAPI.graphicOverlay({color:'#c9f36a',lineWidth:2}); aladin.addOverlay(outline);}
      outline.add(aladinAPI.circle(ra,dec,fov/2));
    }
  }
  async function open() {
    if (aladin || loading) return;
    loading = true;
    $('map-status').hidden = false;
    $('map-status').textContent = 'Opening the reference sky…';
    $('map-retry').hidden = true;
    try {
      const A = await loadLibrary();
      aladinAPI = A;
      if (!A) throw new Error('The reference map library is unavailable. Try coordinates or object name instead.');
      await Promise.race([A.init,new Promise((_,reject)=>setTimeout(()=>reject(new Error('The sky map could not initialise. Check WebGL and your connection, then retry.')),25000))]);
      const root = await referenceSurvey();
      const survey=A.HiPS(root,{name:'DSS2 optical reference',imgFormat:'jpeg',errorCallback:()=>{
        $('map-status').hidden=false;$('map-status').textContent='Reference sky imagery could not be displayed. Please retry.';
        $('map-retry').hidden=false;$('map-select').disabled=$('map-center').disabled=$('map-compare').disabled=true;
        selection=null;aladin?.remove();aladin=null;
      }});
      aladin = A.aladin('#sky-map', {survey, target:'269.446074 +4.770711', fov:15, cooFrame:'ICRS',showFullscreenControl:false,showSimbadPointerControl:false});
      $('map-status').hidden = true;
      $('map-select').disabled = $('map-center').disabled = false;
    } catch (e) {
      $('map-status').textContent = e.message;
      $('map-retry').hidden = false;
      onError(e.message);
    } finally {loading = false;}
  }
  $('map-select').addEventListener('click', () => {
    if (!aladin) return;
    selection = null;
    outline?.removeAll();
    $('map-compare').disabled = true;
    $('map-selection').textContent = 'Drag a rectangle on the map. Zoom in first for a region no wider than 0.5°.';
    aladin.select('rect', ({x,y,w,h}) => {
      try {
        const centre = aladin.pix2world(x+w/2,y+h/2,'ICRS');
        const width = aladin.angularDist(x,y+h/2,x+w,y+h/2,'ICRS');
        const height = aladin.angularDist(x+w/2,y,x+w/2,y+h,'ICRS');
        displaySelection(centre[0],centre[1],Math.max(width,height));
      } catch {selection=null;$('map-compare').disabled=true;onError('Could not read that region. Select a smaller region near the centre of the map.');}
    });
  });
  $('map-center').addEventListener('click', () => {if(aladin) displaySelection(...aladin.getRaDec(),Number($('map-size').value));});
  $('map-size').addEventListener('change', () => {if(selection) displaySelection(selection.ra,selection.dec,Number($('map-size').value));});
  $('map-compare').addEventListener('click', () => {if(selection) onCompare({...selection, band:$('band').value});});
  $('map-retry').addEventListener('click', open);
  return {open, centre(ra,dec){aladin?.gotoRaDec(ra,dec);}};
}
