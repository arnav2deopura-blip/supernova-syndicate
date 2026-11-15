"""Refresh the five saved image products from the current API pipeline at their documented positions.
Uses authentic archive/cache inputs, never changes target coordinates, and validates every blob.
Set SPHEREX_CACHE_DIR to reuse a completed live validation cache. Scientific fit bakes remain
explicitly historical until regenerated separately with precompute.py --science.
"""
import datetime,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from fastapi.testclient import TestClient
from backend import server
from backend.provenance import manifest
from backend.cache import atomic_write
from backend.schemas import FramesResponse
TARGETS={'barnards-star':'D2','eps-indi-b':'D3','wise-0855':'D6','rw-aur':'D2','r-dra':'D2'}
client=TestClient(server.app)
report={'generated_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'processing':manifest(),'targets':{}}
for slug,band in TARGETS.items():
 d=ROOT/'frontend/precomputed'/slug;pos=json.loads((d/'resolve.json').read_text());q={'ra':pos['ra'],'dec':pos['dec'],'fov':.1,'band':band}
 report['targets'][slug]={}
 for matched in [False,True]:
  response=client.get('/api/frames',params={**q,'matched':int(matched)})
  if response.status_code!=200:raise RuntimeError(response.text)
  body=response.json();FramesResponse(**body)
  tag=f'{band}_matched' if matched else band
  for f in body['frames']:
   for key,suffix in [('data',''),('noise','_noise'),('coverage','_coverage')]:
    if not f.get(key):continue
    r=client.get(f[key]);assert r.status_code==200 and len(r.content)==f['width']*f['height']*4
    name=f"{f['epoch_label']}_{tag}{suffix}.bin";atomic_write(d/name,r.content);f[key]=f'precomputed/{slug}/{name}'
  path=d/(f'frames_matched_{band}.json' if matched else 'frames.json')
  atomic_write(path,json.dumps(body,separators=(',',':')).encode())
  report['targets'][slug]['matched' if matched else 'whole_band']=[{'pass':f['epoch_label'],'exposures':f['n_exposures'],'mjd_start':f['mjd_start'],'mjd_end':f['mjd_end']} for f in body['frames']]
  print('REFRESHED',slug,matched,flush=True)
 # Exposure metadata is cheap, shared with the same field query and no invented quality.
 r=client.get('/api/exposures',params={k:v for k,v in q.items() if k!='band'});assert r.status_code==200
 atomic_write(d/'exposures.json',json.dumps(r.json(),separators=(',',':')).encode())
atomic_write(ROOT/'frontend/precomputed/manifest.json',json.dumps(report,indent=2).encode())
