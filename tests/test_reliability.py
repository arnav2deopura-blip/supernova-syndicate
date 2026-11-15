"""Regressions for cache races, restart recovery, queue bounds and truthful metadata."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import threading
import time
import pytest
from backend import cache, catalogs, jobs, provenance, spherex_client

@pytest.fixture
def cache_root(tmp_path, monkeypatch):
 from backend.config import get_config
 monkeypatch.setitem(get_config()['cache'],'dir',str(tmp_path))
 return tmp_path

def test_concurrent_atomic_writes_remain_readable(cache_root):
 path=cache_root/'same.json'
 def write(i):
  for _ in range(10):
   cache.atomic_write(path,json.dumps({'i':i,'payload':'x'*10000}).encode())
   assert len(json.loads(path.read_text())['payload'])==10000
 with ThreadPoolExecutor(8) as pool:list(pool.map(write,range(8)))
 assert not list(cache_root.glob('*.tmp'))

def test_pruning_retains_leased_and_referenced_blobs(cache_root):
 blobs=cache_root/'blobs';blobs.mkdir();a=blobs/('a'*24+'.bin');a.write_bytes(b'x'*10000)
 b=blobs/'leased.bin';b.write_bytes(b'x'*10000)
 cache.put_json('product',{'frames':[{'blob':'a'*24}]})
 cache.lease([b]);cache.prune(max_mb=.001,keep_fraction=.5)
 assert a.exists() and b.exists()

def test_jobs_bound_capacity_and_share_identical_work(cache_root):
 manager=jobs.JobManager(workers=1,capacity=2);release=threading.Event()
 def work(progress):release.wait(3);return {'result_url':'/api/frames'}
 classify=lambda e:('upstream_unavailable',str(e))
 try:
  first=manager.submit('same',work,classify)
  assert manager.submit('same',work,classify).id==first.id
  manager.submit('other',work,classify)
  with pytest.raises(jobs.QueueFull):manager.submit('third',work,classify)
 finally:release.set();manager._pool.shutdown()

def test_job_records_survive_manager_restart(cache_root):
 saved=jobs.Job(id='a'*16,key='x',state='done',finished=time.time(),result={'result_url':'/api/frames'})
 jobs.JobManager._persist(saved)
 manager=jobs.JobManager()
 try:
  assert manager.get(saved.id).result==saved.result
  saved.state='running';jobs.JobManager._persist(saved)
  assert 'restarted' in manager.get(saved.id).message
 finally:manager._pool.shutdown()

def test_fingerprints_detect_equal_size_content_changes(tmp_path):
 p=tmp_path/'index';p.write_text('abc');a=provenance.file_digest(p);p.write_text('xyz')
 assert a!=provenance.file_digest(p)

def test_resolver_without_motion_keeps_j2000(monkeypatch):
 class R:
  status_code=200;text='<Sesame><Target><Resolver name="S"><oname>star</oname><jradeg>10</jradeg><jdedeg>20</jdedeg></Resolver></Target></Sesame>'
 monkeypatch.setattr(catalogs.requests,'get',lambda *a,**k:R())
 result=catalogs.resolve_name('star',to_year=2026)
 assert result['epoch']==2000 and result['propagated'] is False

def test_fov_is_part_of_exposure_selection_identity(cache_root,monkeypatch):
 seen=[]
 monkeypatch.setattr(spherex_client,'_tap_exposures',lambda ra,dec,fov:seen.append(fov) or [])
 monkeypatch.setattr(spherex_client.s3_archive,'find_exposures',lambda *a,**k:[])
 monkeypatch.setattr(spherex_client,'_tap_skip_until',0)
 spherex_client.query_exposures(10,20,.04);spherex_client.query_exposures(10,20,.5)
 assert seen==[.04,.5]

def test_motion_propagation_crosses_a_pole_without_clamping():
 ra,dec=catalogs.propagate(10,89.999,0,10000,2000,2001)
 assert abs(ra-190)<1e-5 and dec<89.999

def test_tap_accepts_quoted_headers_and_relative_urls(monkeypatch):
 class R:
  status_code=200
  text='"uri","time_bounds_lower","energy_bandpassname"\n"ibe/data/spherex/dr1/level2/2025W35_2A/2/level2_2025W35_2A_0474_3D2_spx_l2b-v27-2026-231.fits",60900,SPHEREx-D2\n'
 monkeypatch.setattr(spherex_client.requests,'get',lambda *a,**k:R())
 monkeypatch.setattr(spherex_client.s3_archive,'key_for_filename',lambda x:'')
 r=spherex_client._tap_exposures(10,20,.1)
 assert len(r)==1 and r[0].access_url.startswith('https://irsa.ipac.caltech.edu/ibe/')

def test_direct_build_admission_is_bounded_and_reentrant():
 from backend import server
 release=threading.Event();entered=threading.Event()
 def hold():
  with server._admission():
   with server._admission():entered.set();release.wait(3)
 try:
  with ThreadPoolExecutor(2) as pool:
   a=pool.submit(hold);entered.wait(1)
   with server._admission():
    with ThreadPoolExecutor(1) as other:
     def rejected():
      with pytest.raises(jobs.QueueFull):
       with server._admission():pass
     other.submit(rejected).result()
   release.set();a.result()
 finally:release.set()

def test_authentic_native_cutout_origin_and_epsf_zone():
 import numpy as np
 from astropy.io import fits
 from backend.config import get_config
 from backend.fits_processor import prepare_stamp
 path=Path(__file__).parent/'fixtures/native_irsa_D2.fits'
 with fits.open(path) as h:
  s=prepare_stamp(h,269.446074,4.770711,get_config()['flags'])
  assert (s.x0,s.y0)==(194,431)
  np.testing.assert_array_equal(s.epsf,h['EPSF'].data['EPSF'][1])
  assert abs(s.lam_um-1.5172319181553275)<1e-10

def test_partial_download_counts_and_retry_reuse_successes(cache_root,monkeypatch):
 from astropy.io import fits
 records=[spherex_client.ExposureRecord('good',60000,2,access_url='https://example.test/good.fits'),spherex_client.ExposureRecord('bad',60001,2,access_url='https://example.test/bad.fits')]
 fail=[True];calls=[]
 def cut(record,*args):
  calls.append(record.obs_id)
  if record.obs_id=='bad' and fail[0]:raise OSError('test download failure')
  return fits.HDUList([fits.PrimaryHDU()])
 monkeypatch.setattr(spherex_client,'_cut',cut)
 assert len(spherex_client.fetch_stamps(records,10,20,.1))==1
 key=cache.cache_key('retrieval',10,20,.1,'2',spherex_client.data_version())
 assert cache.get_json(key)['failed']==1
 fail[0]=False
 assert len(spherex_client.fetch_stamps(records,10,20,.1))==2
 assert cache.get_json(key)['failed']==0 and calls.count('good')==1

def test_intersecting_stamp_kept_when_centre_is_off_chip(cache_root):
 import numpy as np
 from astropy.io import fits
 from astropy.wcs import WCS
 from backend.config import get_config
 from backend.fits_processor import prepare_stamp
 from backend import pipeline
 with fits.open(Path(__file__).parent/'fixtures/native_irsa_D2.fits') as h:
  ra,dec=map(float,WCS(h['IMAGE'].header).all_pix2world(-3,11,0))
  stamp=prepare_stamp(h,ra,dec,get_config()['flags'])
 assert stamp is not None and not stamp.target_in_frame
 product=pipeline.coadd_epochs([stamp],ra,dec,.04,'D2')
 assert np.isfinite(product.arrays[0]).any()
 pipeline._save_details(ra,dec,'D2',[stamp])
 detail=pipeline.exposure_details(ra,dec)[(stamp.obs_id,2)]
 assert detail['target_flags'] is None and detail['lam_um'] is None

def test_dense_large_field_is_rejected_before_downloading(cache_root,monkeypatch):
 from backend import pipeline
 from backend.config import get_config
 monkeypatch.setitem(get_config(),'limits',{'max_native_pixels':100})
 monkeypatch.setattr(spherex_client,'query_exposures',lambda *a,**k:[spherex_client.ExposureRecord('one',60000,2)])
 def no_download(*a,**k):raise AssertionError('Cost validation must precede downloads')
 monkeypatch.setattr(spherex_client,'fetch_stamps',no_download)
 with pytest.raises(pipeline.RequestTooLarge,match='smaller field'):pipeline.load_stamps(10,20,.5,'D2')
