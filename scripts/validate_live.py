"""Opt-in archive integration evidence. Uses a new empty cache, never frontend saved products.
Run: python scripts/validate_live.py --output docs/LIVE_VALIDATION.json
Uses actual API routes, downloads and blob decoding. May take tens of minutes.
"""
import argparse
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
import time
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
TARGETS=[
 ('Barnards Star',269.446074,4.770711,'D2'),
 ('Epsilon Indi B',331.0984021,-56.8012569,'D3'),
 ('WISE 0855',133.7577838,-7.2420232,'D6'),
 ('RW Aurigae',76.9565886,30.4012864,'D2'),
 ('R Draconis',248.1672204,66.7550253,'D2'),
 ('nonpreset offset',269.49,4.79,'D2'),
 ('RA wrap',0.001,0.0,'D2'),
 ('polar field',180.0,89.8,'D2'),
]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--output',default='docs/LIVE_VALIDATION.json');ap.add_argument('--cache-dir');ap.add_argument('--limit',type=int,default=len(TARGETS));args=ap.parse_args()
 cache_dir=args.cache_dir or tempfile.mkdtemp(prefix='spherex-cold-')
 os.environ['SPHEREX_CACHE_DIR']=cache_dir
 from fastapi.testclient import TestClient
 import numpy as np
 from backend.server import app
 from backend.provenance import manifest
 report={'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'empty_cache':not bool(args.cache_dir),'cache_directory':cache_dir,'manifest':manifest(),'scenarios':[]}
 output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
 def run(target):
  label,ra,dec,band=target;t=time.monotonic();out={'name':label,'request':{'ra':ra,'dec':dec,'fov':0.1,'band':band},'products':[]}
  with TestClient(app) as client:
   for matched in [False,True]:
    r=client.get('/api/frames',params={**out['request'],'matched':int(matched),'async':1})
    deadline=time.monotonic()+1200
    while r.status_code==202:
     job=r.json()
     print(label,matched,job.get('state'),job.get('stage'),job.get('done'),job.get('total'),flush=True)
     if job.get('state')=='error':break
     if job.get('state')=='done':r=client.get(job['result']['result_url']);break
     if time.monotonic()>deadline:out['timeout']=True;break
     time.sleep(5);r=client.get(job['status_url']);
     if r.status_code==200 and r.json().get('state') in ('queued','running','done','error'):
      r.status_code=202
    body=r.json();product={'matched':matched,'status':r.status_code,'retrieval':body.get('retrieval'),'error':body.get('message')}
    if 'frames' in body:
     product['frames']=[]
     for f in body['frames']:
      b=client.get(f['data']);values=np.frombuffer(b.content,dtype='<f4')
      assert b.status_code==200 and values.size==f['width']*f['height'] and np.isfinite(values).any()
      product['frames'].append({k:f.get(k) for k in ['epoch_label','mjd_start','mjd_end','n_exposures','obs_ids','flag_fraction']})
     product['completeness']=body.get('completeness');product['passed']=len(body['frames'])>=2
     if matched:
      export=client.get('/api/frames.fits',params={**out['request'],'matched':1})
      product['fits_status']=export.status_code;assert export.content.startswith(b'SIMPLE')
    out['products'].append(product)
   out['seconds']=round(time.monotonic()-t,1)
  return out
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  futures={pool.submit(run,t):t[0] for t in TARGETS[:args.limit]}
  for future in concurrent.futures.as_completed(futures):
   try:result=future.result()
   except Exception as e:result={'name':futures[future],'exception':str(e)}
   report['scenarios'].append(result);output.write_text(json.dumps(report,indent=2));print('FINISHED',result['name'],flush=True)
 report['finished_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 report['passed_all']=len(report['scenarios'])==min(args.limit,len(TARGETS)) and all(len(s.get('products',[]))==2 and all(p.get('passed') for p in s['products']) for s in report['scenarios'])
 output.write_text(json.dumps(report,indent=2));raise SystemExit(0 if report['passed_all'] else 1)
if __name__=='__main__':main()
