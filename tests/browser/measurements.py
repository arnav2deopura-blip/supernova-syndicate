"""Live-services and authentic-bake acceptance checks; requires Chrome and Playwright."""
import os
from playwright.sync_api import sync_playwright
BASE=os.environ.get('SPHEREX_PREVIEW_URL','http://localhost:5600')
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),headless=True)
 page=b.new_page(viewport={'width':1440,'height':1000});page.set_default_timeout(30000)
 errors=[];page.on('pageerror',lambda e:errors.append(e.stack))
 def mark(text): print('PASS',text,flush=True)
 for name in ["Barnard's Star",'eps Indi B','WISE J085510.83-071442.5','RW Aur','R Dra']:
  from urllib.parse import urlencode
  page.goto(BASE+'/?'+urlencode({'api':'default','name':name}))
  page.wait_for_function("document.querySelector('#badges').textContent.includes('Saved')")
  assert page.locator('#image').evaluate('(c)=>c.width')>48
  mark(name+' real frames')
 # The cold dwarf has authentic channel-resolved saved data.
 page.goto(BASE+'/?name=WISE+J085510.83-071442.5&api=default')
 page.wait_for_function("document.querySelector('#badges').textContent.includes('Saved')")
 page.locator('#search-expand').click()
 page.locator('[data-wl=range]').click()
 # channel 13 is seen in every pass of WISE 0855 (a range with a gap stops and asks instead)
 page.keyboard.press('Escape')
 page.locator('#ch-lo').fill('13');page.locator('#ch-hi').fill('13');page.locator('#ch-apply').click()
 page.wait_for_function("document.querySelector('#target-label').textContent.includes('WISE') && document.querySelector('#progress').hidden")
 assert 'channels' in page.locator('#badges').inner_text();mark('channel selection produces images')
 page.locator('[data-wl=detector]').click()
 page.wait_for_function("document.querySelector('#progress').hidden")
 page.locator('[data-view=colours]').click()
 page.wait_for_function("document.querySelector('#filmstrip').querySelectorAll('button').length>0")
 mark('colour channel images and filmstrip')
 page.locator('[data-view=blink]').click()
 page.locator('#show-events').uncheck()
 # Coordinate-matched spectrum is served from authentic precomputed photometry.
 page.locator('#image').click(position={'x':page.locator('#image').bounding_box()['width']/2,'y':page.locator('#image').bounding_box()['height']/2})
 page.locator('#advanced').evaluate('(e)=>e.open=true')
 page.wait_for_function("[...document.querySelectorAll('#adv-body button')].some(b=>b.textContent==='Spectrum CSV')",timeout=60000)
 with page.expect_download() as spectrum:page.get_by_role('button',name='Spectrum CSV',exact=True).click()
 assert spectrum.value.suggested_filename.endswith('.csv');mark('pixel spectrum and export')
 print('ERRORS',errors,flush=True);assert not errors,errors
 b.close()
