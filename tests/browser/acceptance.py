from playwright.sync_api import sync_playwright
import json, os
BASE=os.environ.get("SPHEREX_PREVIEW_URL","http://localhost:5600")
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),headless=True)
 page=b.new_page(viewport={'width':1440,'height':1000});page.set_default_timeout(20000)
 errors=[];page.on('pageerror',lambda e:errors.append(e.stack))
 page.goto(BASE+'/?api=default&name=Barnard%27s+Star')
 page.wait_for_function("document.querySelector('#badges').textContent.includes('Saved')")
 def mark(x): print('PASS',x,flush=True)
 mark('real cached observations rendered')
 for selector in ['#play','#prev','#next']:
  page.locator(selector).click();mark(selector)
 page.locator('#speed').fill('7')
 page.locator('#timeline button').first.click()
 for view in ['smooth','pair','diff','changes','sum','blink','colours','blink']:
  page.locator('[data-view='+view+']').click();page.wait_for_timeout(500);mark('view '+view)
 page.select_option('#zoom','2');page.select_option('#zoom','1')
 page.locator('#display-opts').evaluate('(e)=>e.open=true')
 for cmap in ['inferno','viridis','gray']:page.select_option('#cmap',cmap)
 page.select_option('#stretch','linear');page.locator('#clip').fill('98')
 page.locator('#show-overlay').uncheck();page.locator('#show-events').uncheck()
 with page.expect_download() as dl:page.locator('#save-png').click()
 assert dl.value.suggested_filename.endswith('.png');mark('image export')
 page.locator('[data-view=pair]').click()
 with page.expect_download(timeout=30000) as movie:
  page.locator('#save-movie').click()
 assert movie.value.suggested_filename.endswith(('.webm','.mp4'));mark('movie export')
 assert page.locator('#save-movie').is_enabled()
 assert page.locator('[data-view=pair]').get_attribute('aria-checked')=='true'
 page.locator('[data-view=blink]').click()

 page.locator('#advanced').evaluate('(e)=>e.open=true');page.wait_for_timeout(3000)
 print('ADV',page.locator('#adv-body').inner_text()[:700],flush=True)
 assert 'Unknown' not in page.locator('#adv-body').inner_text();mark('advanced has no unknown grid')
 with page.expect_download() as metadata:
  page.get_by_role('button',name='Observation metadata CSV',exact=True).click()
 assert metadata.value.suggested_filename.endswith('.csv');mark('metadata export')
 page.locator('#guide-btn').click();page.locator('#guide-close').click();mark('guide open close')
 page.locator('#tour-btn').click();page.locator('.tour-skip').click();mark('tour skip')
 page.locator('#show-on-sky').click()
 page.wait_for_function("document.querySelector('#sky-view').disabled===false",timeout=40000)
 page.locator('#sky-view').click();assert page.locator('#sky-compare').is_enabled();mark('sky current view selectable')
 print('SELECTION',page.locator('#sky-sel').inner_text(),flush=True)
 page.screenshot(path='/tmp/full-audit.png',full_page=True)
 # Arbitrary map selection must produce a real backend request with the selected coordinates.
 seen=[]
 page.on('request',lambda r:seen.append(r.url) if '/api/frames?' in r.url else None)
 page.locator('#sky-compare').click();page.wait_for_timeout(1200)
 assert seen, 'Map Compare did not request images';mark('sky selection reaches real frames API')
 if page.locator('#progress-cancel').is_visible(): page.locator('#progress-cancel').click()
 # Deterministic slow request checks cancellation even when live data is already cached.
 page.route('**/api/frames?**',lambda route:route.fulfill(status=202,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'job_id':'audit','state':'running','stage':'test','status_url':'https://spherex-api.redgrass-773e0da8.canadacentral.azurecontainerapps.io/api/jobs/audit'})))
 page.route('**/api/jobs/audit',lambda route:route.fulfill(content_type='application/json',body=json.dumps({'job_id':'audit','state':'running','stage':'test'})))
 page.goto(BASE+'/?api=default&fresh=1&mode=coords&ra=10&dec=20&fov=0.04')
 page.wait_for_function("!document.querySelector('#progress').hidden && document.querySelector('#progress-text').textContent.includes('elapsed')")
 page.locator('#progress-cancel').click()
 assert page.locator('#progress').is_hidden();mark('search cancellation')
 page.locator('#search-expand').click();page.locator('#tab-coords').click()
 page.locator('#ra').fill('999');page.locator('#dec').fill('20')
 page.locator('#panel-coords button[type=submit]').click()
 assert page.locator('#ra').get_attribute('aria-invalid')=='true';mark('invalid coordinates blocked')
 page.set_viewport_size({'width':390,'height':844})
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');mark('mobile width')
 print('ERRORS',errors,flush=True);assert not errors,errors
 mark('no JavaScript errors')
 b.close()
