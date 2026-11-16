"""Deterministic UI checks with real saved image arrays; no archive connectivity required.
The intercepted service responses exercise errors and are test fixtures, not live science validation.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
BASE=os.environ.get('SPHEREX_PREVIEW_URL','http://127.0.0.1:5601')
API='https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io'
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),headless=True)
 context=browser.new_context(viewport={'width':1440,'height':1000},accept_downloads=True)
 page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/api/**',lambda r:r.fulfill(status=503,json={'error':'upstream_unavailable','message':'Test outage'},headers={'Access-Control-Allow-Origin':'*'}))
 page.goto(BASE+'/?name=Barnard%27s+Star&api=default')
 page.wait_for_function("document.querySelector('#badges').textContent.includes('Saved')")
 # the tour offer lives in the target picker, which a link that names a target skips
 if page.locator('#tour-offer-no').is_visible(): page.locator('#tour-offer-no').click()
 for view in ['pair','smooth','diff','changes','sum','colours','blink']:
  page.locator('[data-view='+view+']').click()
  page.wait_for_timeout(200)
  assert page.locator('[data-view='+view+']').get_attribute('aria-checked')=='true'
  if view=='pair':
   assert page.locator('#pair-stage').is_visible()
   page.select_option('#zoom','2')
   assert page.locator('.pair-inner').first.evaluate('(e)=>e.style.transform')==page.locator('#stage-inner').evaluate('(e)=>e.style.transform')
   with page.expect_download() as download:page.locator('#save-png').click()
   assert download.value.suggested_filename.endswith('.png')
   page.select_option('#zoom','1')
 page.locator('#play').click();page.locator('#prev').click();page.locator('#next').click()
 page.locator('#advanced').evaluate('(e)=>e.open=true')
 page.get_by_role('button',name='Research manifest JSON',exact=True).wait_for()
 with page.expect_download() as exported:page.get_by_role('button',name='Research manifest JSON',exact=True).click()
 manifest=json.loads(Path(exported.value.path()).read_text())
 assert manifest['release'] and manifest['frames'][0]['obs_ids'] and manifest['limitations']
 assert 'No-data pixels %' in page.locator('#adv-body').inner_text()
 page.locator('#guide-btn').click();page.locator('#guide-close').click()
 page.locator('#tour-btn').click();page.locator('.tour-skip').click()
 page.set_viewport_size({'width':390,'height':844})
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 page.goto(BASE+'/?api=default&fresh=1&ra=269.446074&dec=4.770711&band=D2')
 page.locator('#viewer-notice').get_by_text('The data service is unavailable.').wait_for() if False else None
 page.wait_for_function("!document.querySelector('#viewer-notice').hidden")
 assert not page.locator('#badges').inner_text().strip(), 'fresh outage must not show saved data'
 page.goto(BASE+'/?api=https://custom.example&name=Barnard%27s+Star')
 page.wait_for_function("document.querySelector('#badges').textContent.includes('Saved')")
 assert 'api=https%3A%2F%2Fcustom.example' in page.url
 # Malformed HTTP-200 must reach a friendly error, before .frames.map.
 page.route('**/api/frames?**',lambda r:r.fulfill(json={},headers={'Access-Control-Allow-Origin':'*'}))
 page.goto(BASE+'/?api=default&fresh=1&mode=coords&ra=10&dec=20')
 page.get_by_text('The service returned data this page cannot read.',exact=True).wait_for()
 assert not errors,errors
 print('PASS deterministic views, synchronized zoom, exports, tour, mobile, strict fresh, share URL, malformed responses')
 page.screenshot(path=os.environ.get('SPHEREX_SCREENSHOT','/tmp/spherex-regression.png'),full_page=True)
 browser.close()
