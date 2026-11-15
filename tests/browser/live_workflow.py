"""Opt-in real browser + real API: typed coordinates and map selection must finish.
No route interception or saved data. Requires a running local/remote API and archive access.
"""
import datetime,json,os,time
from pathlib import Path
from urllib.parse import quote,urlparse,parse_qs
from playwright.sync_api import sync_playwright
BASE=os.environ.get('SPHEREX_PREVIEW_URL','http://localhost:5601')
API=os.environ.get('SPHEREX_TEST_API','http://127.0.0.1:8001')
report={'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'api':API,'scenarios':[]}
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),headless=True)
 page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];responses=[]
 page.on('pageerror',lambda error:errors.append(str(error)))
 def response(r):
  if '/api/frames?' in r.url and r.status==200:
   try:responses.append(r.json())
   except Exception:pass
 page.on('response',response)
 page.goto(BASE+'/?api='+quote(API,safe='')+'&fresh=1&mode=coords')
 page.locator('#ra').fill('269.470000');page.locator('#dec').fill('+4.790000');page.select_option('#fov','0.04')
 def complete(label):
  started=time.monotonic()
  while time.monotonic()-started<1200:
   page.wait_for_timeout(2000)
   if page.locator('#badges').inner_text().find('Archive build')>=0 or page.locator('#badges').inner_text().find('Server cache')>=0:break
   if not page.locator('#viewer-notice').is_hidden() and page.locator('#viewer-notice').get_attribute('class').find('notice-error')>=0:
    raise AssertionError(page.locator('#viewer-notice').inner_text())
  else:raise AssertionError('Live frames did not finish')
  assert responses and responses[-1]['frames']
  r=responses[-1]
  assert r['ra'] and r['wcs'] and page.locator('#play').is_enabled()
  assert 'Saved' not in page.locator('#badges').inner_text()
  report['scenarios'].append({'name':label,'seconds':round(time.monotonic()-started,1),'ra':r['ra'],'dec':r['dec'],'fov':r['fov'],'frame_count':len(r['frames']),'retrieval':r.get('retrieval'),'provenance':r.get('provenance'),'completeness':r.get('completeness')})
  print('PASS',label,json.dumps(report['scenarios'][-1]),flush=True)
 page.locator('#panel-coords button[type=submit]').click();complete('typed nonpreset coordinates')
 assert abs(responses[-1]['ra']-269.47)<1e-6
 page.locator('[data-view=pair]').click();page.select_option('#zoom','2');page.select_option('#zoom','1')
 page.locator('[data-view=blink]').click()
 page.locator('#show-on-sky').click();page.wait_for_function("!document.querySelector('#sky-view').disabled",timeout=60000)
 # Click a nearby map position rather than merely checking a request starts.
 page.locator('#sky').click(position={'x':420,'y':210});page.locator('#sky-compare').wait_for(state='visible');assert page.locator('#sky-compare').is_enabled()
 page.locator('#sky-compare').click();complete('free explore selection through completed observations')
 page.screenshot(path='/tmp/spherex-live-workflow.png',full_page=True)
 assert not errors,errors
 report['javascript_errors']=errors;report['finished_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 Path('docs/BROWSER_LIVE_VALIDATION.json').write_text(json.dumps(report,indent=2))
 browser.close()
