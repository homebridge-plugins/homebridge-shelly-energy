# python3 -I test/ui-fresh.py <port> - a fresh install (test/ui-serve.js <port> fresh): no block in config.json, plugin not
# running. The settings page must offer to set it up, add the block, and say what to do next.
import json, sys, time
from playwright.sync_api import sync_playwright

port = sys.argv[1] if len(sys.argv) > 1 else '8609'
checks = []
def check(name, cond):
    checks.append(name)
    if not cond: raise AssertionError(name)
    print('ok', name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
    page = b.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}'); page.wait_for_selector('#ui')
    pg = next(f for f in page.frames if f.url.endswith('/inner'))
    pg.wait_for_selector('#firstSetup', timeout=15000)
    check('a fresh install is offered "Set up the plugin"', 'Welcome' in pg.inner_text('#notRunning') and 'Bridge Settings' in pg.inner_text('#notRunning'))
    pg.click('#firstSetup'); time.sleep(1)
    cfg = json.loads(pg.evaluate("fetch('/config').then(r => r.text())"))
    check('its block is added to config.json', cfg == [{'platform': 'ShellyHomeEnergy', 'name': 'Shelly Home Energy'}])
    time.sleep(3.5)
    check('then the next steps, and they stay up', 'Set up.' in pg.inner_text('#notRunning') and 'child bridge' in pg.inner_text('#notRunning') and not pg.query_selector('#firstSetup'))
    check('no page errors', not errors)
    b.close()
print(f'{len(checks)} checks passed')
