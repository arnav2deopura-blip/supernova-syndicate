"""Opt-in comparison of one native IRSA cutout and public S3 byte-range stamp.
A supplied --s3-key avoids depending on TAP for the cutout compatibility check.
"""
import argparse,datetime,io,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import numpy as np
import requests
from astropy.io import fits
from backend import spherex_client,s3_archive
from backend.config import get_config
from backend.fits_processor import prepare_stamp

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--s3-key');ap.add_argument('--ra',type=float,default=269.446074);ap.add_argument('--dec',type=float,default=4.770711);args=ap.parse_args()
 out={'tested_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ra':args.ra,'dec':args.dec}
 original=requests.get
 def observed(url,*a,**kw):
  response=original(url,*a,**kw)
  if '/TAP/' in url:out['tap_response_preview']=response.text[:600]
  return response
 requests.get=observed
 try:
  rows=spherex_client._tap_exposures(args.ra,args.dec,.04);out['tap']={'status':'passed','records':len(rows)}
 except Exception as exc:
  rows=[];out['tap']={'status':'unavailable','error':str(exc)}
 requests.get=original
 key=args.s3_key or next((r.s3_key for r in rows if r.detector==2 and r.s3_key),None)
 if key:
  url='https://irsa.ipac.caltech.edu/ibe/data/spherex/'+key
  out['native_url']=spherex_client.cutout_url(url,args.ra,args.dec,.04);out['s3_key']=key
  try:
   response=requests.get(out['native_url'],timeout=60);out['native_http_status']=response.status_code;response.raise_for_status()
   with fits.open(io.BytesIO(response.content)) as h:
    a=prepare_stamp(h,args.ra,args.dec,get_config()['flags']);native_image=h['IMAGE'].data.copy();native_zodi=h['ZODI'].data.copy()
   h=s3_archive.cut_stamp(key,args.ra,args.dec,32);b=prepare_stamp(h,args.ra,args.dec,get_config()['flags'])
   positions=[a.wcs.all_world2pix(args.ra,args.dec,0),b.wcs.all_world2pix(args.ra,args.dec,0)]
   pixels=[float((img-zodi)[int(round(float(pos[1]))),int(round(float(pos[0])))]) for img,zodi,pos in zip([native_image,h['IMAGE'].data],[native_zodi,h['ZODI'].data],positions)]
   out['comparison']='IMAGE minus ZODI at the same sky pixel, before stamp-dependent local background subtraction'
   out['native']={'shape':list(a.image.shape),'wavelength_um':a.lam_um,'target_flags':a.target_flags,'target_pixel':pixels[0]}
   out['s3']={'shape':list(b.image.shape),'wavelength_um':b.lam_um,'target_flags':b.target_flags,'target_pixel':pixels[1]}
   out['wavelength_difference_um']=abs(a.lam_um-b.lam_um)
   out['epsf_max_difference']=float(np.max(np.abs(a.epsf-b.epsf)))
   out['native_origin']=[a.x0,a.y0]
   out['s3_origin']=[b.x0,b.y0]
   out['passed']=bool(out['wavelength_difference_um'] < 1e-5 and a.target_flags==b.target_flags and np.isclose(*pixels,rtol=1e-4,equal_nan=True) and out['epsf_max_difference'] < 1e-10)
  except Exception as exc:out['native_error']=str(exc)
 else:out['native_error']='No matching input record available for a native cutout test.'
 (ROOT/'docs/NATIVE_ARCHIVE_VALIDATION.json').write_text(json.dumps(out,indent=2));print(json.dumps(out),flush=True)
if __name__=='__main__':main()
