import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.env.PASEO_AUTH_BROWSER_SOURCE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const requireBrowser = process.env.PASEO_REQUIRE_AUTH_BROWSER === '1';
const available = spawnSync('python3', ['-c',
  'import inspect; from playwright.sync_api import BrowserType; assert "no_defaults" in inspect.signature(BrowserType.connect_over_cdp).parameters'],
{ stdio: 'ignore' }).status === 0;

// Full Chromium's native tab visibility is essential here. Playwright's normal
// launch enables focus emulation, which keeps background tabs document.visible.
// Connect to a fresh, disposable browser without those overrides instead. Every
// HTTP request is fulfilled or aborted locally; no OAuth/provider is contacted.
const program = String.raw`
import json, os, signal, subprocess, sys, tempfile, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

root = Path(sys.argv[1])
origin = "https://paseo-auth-fixture.invalid"
marker = "SYNTHETIC_ONLY"
cases = []
active = None
proc = None

def interrupted(*_):
 # node's bounded subprocess timeout must not leave the disposable browser.
 if proc is not None and proc.poll() is None:
  try: os.killpg(proc.pid,signal.SIGKILL)
  except ProcessLookupError: pass
 raise SystemExit(124)
signal.signal(signal.SIGTERM,interrupted)

class Fixture:
 def __init__(self, context, provider, deadline_ms=90000):
  self.context, self.provider = context, provider
  self.calls, self.errors, self.completed = [], [], False
  self.status_http, self.hold_start, self.held = 200, False, None
  self.hold_status, self.held_status = False, None
  self.page = context.new_page()
  self.page.on("pageerror", lambda error: self.errors.append(error.name))
  self.page.clock.install(time=datetime(2026,10,25,12,0,0,tzinfo=timezone.utc))
  self.page.clock.pause_at(datetime(2026,10,25,12,0,1,tzinfo=timezone.utc))
  self.page.goto(origin+"/paseo/setup/", wait_until="domcontentloaded")
  self.page.bring_to_front()
  self.page.locator("#refresh").click()
  expect(self.page.locator("#login")).to_be_enabled()
  self.page.locator("#provider").select_option(provider)
  self.expires_ms = self.page.evaluate("Date.now()") + deadline_ms
  self.expiry = datetime.fromtimestamp(self.expires_ms/1000,timezone.utc).isoformat()

 def current(self):
  return {"schemaVersion":1,"version":"0.11.2","phase":"running","desiredEnabled":True,
   "daemon":{"running":True,"reachable":True,"relayEnabled":True},"operation":None,
   "providers":[{"provider":p,"status":"ready","authentication":"needs_chat_verification"} for p in ["claude","codex","pi"]]}

 def pending(self):
  host = "claude.ai" if self.provider == "claude" else "auth.openai.com"
  return {"provider":self.provider,"phase":"awaiting_authorization","expiresAt":self.expiry,
   "authorizationUrl":"https://"+host+"/offline-fixture?state="+marker,
   **({"requiresCode":True} if self.provider == "pi" else {}),
   **({"deviceCode":"TEST-ONLY"} if self.provider == "codex" else {})}

 def reply(self, route, value, status=200):
  route.fulfill(status=status, content_type="application/json", body=json.dumps(value))

 def handle(self, route):
  request = route.request
  if request.method == "GET":
   self.calls.append({"method":"GET"}); self.reply(route,self.current()); return
  body = request.post_data_json
  self.calls.append({"method":"POST","action":body.get("action"),"step":body.get("step")})
  if body.get("action") == "models":
   self.reply(route,{"provider":self.provider,"models":[{"id":"fixture-model","label":"Fixture","isDefault":True}],"modes":[]}); return
  assert body.get("action") == "login", "Unexpected mutation in offline fixture"
  assert body.get("provider") == self.provider
  step = body.get("step")
  if step == "start" and self.hold_start: self.held=route; return
  if step == "status" and self.hold_status: self.held_status=route; return
  if step == "status" and self.status_http != 200:
   self.reply(route,{"error":{"code":"AUTH_REQUIRED"}},self.status_http); return
  if step == "complete":
   assert self.provider == "pi" and body.get("code") == marker+"_NEW_CALLBACK"
   self.completed=True
  self.reply(route,{"provider":self.provider,"phase":"authorization_completed"} if self.completed else self.pending())

 def start(self):
  self.page.locator("#login").click()
  if not self.hold_start: expect(self.page.locator("#login-link")).to_be_visible()

 def wait(self, predicate, description):
  # Python-side polling avoids wait_for_function's repeated eval under the
  # production CSP. evaluate here only reads state through the DevTools API.
  end=time.monotonic()+3
  while not predicate():
   assert time.monotonic()<end, description
   self.page.wait_for_timeout(20)

 def away(self, official=True):
  if official:
   assert self.page.locator("#login-link").get_attribute("target") == "_blank"
   with self.page.expect_popup() as popup: self.page.locator("#login-link").click()
   self.other=popup.value; self.other.wait_for_load_state()
  else:
   self.other=self.context.new_page(); self.other.goto(origin+"/away")
  self.other.bring_to_front()
  self.wait(lambda: self.page.evaluate("document.hidden"),"Chromium did not hide the original tab")
  self.assert_cleared()

 def assert_cleared(self):
  assert self.page.locator("#login-link").get_attribute("href") is None
  assert self.page.locator("#login-code-input").input_value() == ""
  assert self.page.locator("#login-code").inner_text() == ""
  assert self.page.locator("#login-panel").get_attribute("hidden") is not None
  assert marker not in self.page.content()
  assert self.page.evaluate("localStorage.length + sessionStorage.length") == 0

 def hidden_wait(self, milliseconds):
  count=len(self.calls)
  self.page.clock.run_for(milliseconds)
  self.page.wait_for_timeout(40)
  assert len(self.calls)==count, "Hidden page issued an API request"
  self.assert_cleared()

 def back(self):
  self.page.bring_to_front()
  self.wait(lambda: not self.page.evaluate("document.hidden"),"Chromium did not reveal the original tab")
  self.page.clock.run_for(0)

 def finish(self, name):
  assert not self.errors, "Browser script exception"
  assert len([c for c in self.calls if c.get("step")=="start"])==1, "Return auto-started OAuth"
  assert self.page.evaluate("localStorage.length + sessionStorage.length") == 0
  assert not self.context.cookies(), "Fixture persisted browser credentials"
  cases.append(name)
  for page in [self.page,getattr(self,"other",None)]:
   if page and not page.is_closed(): page.close()

def serve(route):
 url=urlsplit(route.request.url)
 # These official-looking fixture destinations never leave route.fulfill.
 if url.hostname in ["claude.ai","auth.openai.com"] and url.path=="/offline-fixture":
  route.fulfill(status=200,content_type="text/html",body="<html><body>Offline authorization fixture</body></html>"); return
 if url.hostname != urlsplit(origin).hostname: route.abort(); return
 files={"/paseo/setup/":("ui/setup.html","text/html; charset=utf-8"),
  "/paseo/assets/setup.js":("ui/setup.js","text/javascript"),"/paseo/assets/setup.css":("ui/setup.css","text/css")}
 if url.path in files:
  file,kind=files[url.path]
  route.fulfill(status=200,content_type=kind,body=(root/file).read_text(),headers={"Cache-Control":"no-store",
   "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}); return
 if url.path=="/api/paseo-bridge" and active is not None: active.handle(route); return
 if url.path=="/away": route.fulfill(status=200,content_type="text/html",body="<html><body>Other tab</body></html>"); return
 route.fulfill(status=404,body="Not found")

with sync_playwright() as pw:
 configured=os.environ.get("PASEO_TEST_CHROMIUM_EXECUTABLE")
 candidates=[Path(configured or pw.chromium.executable_path)]
 if not configured:
  # A driver update may leave a usable full Chromium at a previous cache
  # revision. CDP is version tolerant; report the actual tested browser below.
  cache=Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH",str(Path.home()/".cache/ms-playwright")))
  candidates.extend(sorted(cache.glob("chromium-*/chrome-*/chrome"),reverse=True))
 executable=next((p for p in candidates if p.is_file()),None)
 if executable is None:
  print(json.dumps({"skip":"Full Chromium is unavailable; set PASEO_TEST_CHROMIUM_EXECUTABLE or install the Playwright chromium browser"})); sys.exit(0)
 with tempfile.TemporaryDirectory(prefix="paseo-auth-browser-") as profile:
  command=[str(executable),"--headless=new","--no-sandbox","--no-first-run","--no-default-browser-check","--disable-dev-shm-usage",
   "--disable-background-networking","--disable-component-update","--disable-default-apps","--disable-sync",
   "--disable-features=OptimizationHints,MediaRouter","--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
   "--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--user-data-dir="+profile,"about:blank"]
  proc=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  browser=None
  try:
   portfile=Path(profile)/"DevToolsActivePort"
   for _ in range(200):
    if portfile.is_file(): break
    assert proc.poll() is None, "Chromium failed to start"
    time.sleep(.05)
   assert portfile.is_file(), "Chromium debugging port timed out"
   browser=pw.chromium.connect_over_cdp("http://127.0.0.1:"+portfile.read_text().splitlines()[0],no_defaults=True)
   context=browser.contexts[0]; context.route("**/*",serve)

   def make(provider,**kwargs):
    global active
    # Install the handler before __init__ performs the initial status request.
    active=Fixture.__new__(Fixture); active.__init__(context,provider,**kwargs); return active

   f=make("pi"); f.start(); f.page.locator("#login-code-input").fill(marker+"_OLD_INPUT")
   f.away(); f.hidden_wait(30000)
   f.hold_status=True; f.back()
   f.wait(lambda: f.held_status is not None,"Return did not query protected login status")
   expect(f.page.locator("#login")).to_be_disabled()
   f.assert_cleared()
   f.reply(f.held_status,f.pending()); f.hold_status=False
   expect(f.page.locator("#login-input")).to_be_visible()
   expect(f.page.locator("#login-code-input")).to_have_value("")
   f.page.locator("#login-code-input").fill(marker+"_NEW_CALLBACK"); f.page.locator("#login-submit").click()
   expect(f.page.locator("#login-message")).to_contain_text("官方登入流程已完成")
   expect(f.page.locator("#login-input")).to_be_hidden()
   expect(f.page.locator("#login-code-input")).to_have_value("")
   expect(f.page.locator("#model")).to_be_disabled()
   f.page.locator("#models").click(); expect(f.page.locator("#model")).to_have_value("fixture-model")
   assert f.completed
   f.finish("Pi return waits for fresh status, accepts a new callback, then refreshes models")

   for provider in ["claude","codex"]:
    f=make(provider); f.start(); f.away(); f.completed=True; f.hidden_wait(30000); f.back()
    expect(f.page.locator("#login-message")).to_contain_text("官方登入流程已完成")
    assert len([c for c in f.calls if c.get("step")=="status"])==1
    assert f.page.locator("#login-link").get_attribute("href") is None
    f.finish(provider+" return observes completion without restarting OAuth")

   f=make("pi",deadline_ms=60000); f.start(); f.away(); f.hidden_wait(30000); f.back()
   expect(f.page.locator("#login-input")).to_be_visible()
   # Hide a second time and cross the original deadline. Recovery must not renew it.
   f.other.bring_to_front(); f.wait(lambda: f.page.evaluate("document.hidden"),"Chromium did not hide the original tab"); f.hidden_wait(31000)
   count=len([c for c in f.calls if c.get("action")=="login"]); f.back(); f.page.wait_for_timeout(50)
   f.assert_cleared()
   assert len([c for c in f.calls if c.get("action")=="login"])==count
   f.finish("Return after the original deadline does not restore or extend OAuth")

   f=make("pi"); f.start(); f.away(); f.hidden_wait(1000); f.status_http=401; f.back()
   expect(f.page.locator("#notice")).to_contain_text("需要 OpenDesign 登入")
   f.assert_cleared(); expect(f.page.locator("#login")).to_be_disabled()
   count=len(f.calls); f.page.clock.run_for(30000); f.page.wait_for_timeout(40)
   assert len(f.calls)==count, "401 must stop both polling lanes"
   f.finish("Protected status 401 clears UI and stops all automatic requests")

   f=make("codex"); f.hold_start=True; f.start(); assert f.held is not None
   f.away(official=False); f.reply(f.held,f.pending()); f.page.wait_for_timeout(50); f.assert_cleared()
   f.completed=True; f.back(); f.page.clock.run_for(5000)
   expect(f.page.locator("#login-message")).to_contain_text("官方登入流程已完成")
   assert len([c for c in f.calls if c.get("step")=="status"])==1
   f.finish("A start response arriving while hidden recovers only through fresh status")

   f=make("claude"); f.start(); f.page.locator("#login-close").click(); f.away(official=False)
   f.hidden_wait(1000); count=len(f.calls); f.back(); f.page.wait_for_timeout(50)
   f.assert_cleared(); assert len(f.calls)==count
   f.finish("Explicit close prevents later tab return from restoring OAuth")

   print(json.dumps({"cases":cases,"browserVersion":browser.version,"nativeVisibility":True,
    "externalRequestsContinued":0,"oauthStarted":False,"persistentCredentials":False}))
  finally:
   try:
    if browser is not None: browser.close()
   finally:
    if proc.poll() is None:
     os.killpg(proc.pid,signal.SIGTERM)
     try: proc.wait(timeout=5)
     except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL); proc.wait()
`;

test('Chromium native tab visibility: protected provider auth resumes without retaining secrets', {
  skip: available || requireBrowser ? false : 'Python Playwright with connect_over_cdp(no_defaults) is required',
  timeout: 120000,
}, async t => {
  assert.ok(available, 'AUTH_BROWSER_REQUIRED: Python Playwright with connect_over_cdp(no_defaults) is unavailable');
  const result = spawnSync('python3', ['-c', program, root], {
    encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.code || result.stderr?.slice(-5000) || 'AUTH_BROWSER_CHECK_FAILED');
  const report = JSON.parse(result.stdout.trim());
  if (report.skip) {
    assert.equal(requireBrowser, false, `AUTH_BROWSER_REQUIRED: ${report.skip}`);
    t.skip(report.skip); return;
  }
  assert.equal(report.nativeVisibility, true);
  assert.equal(report.externalRequestsContinued, 0);
  assert.equal(report.oauthStarted, false);
  assert.equal(report.cases.length, 7);
  for (const name of report.cases) await t.test(name, () => {});
  t.diagnostic(`Chromium ${report.browserVersion}; native hidden/visible events; synthetic routes only`);
});
