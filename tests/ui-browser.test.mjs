import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const available = spawnSync('python3', ['-c', 'import playwright.sync_api'], { stdio: 'ignore' }).status === 0;

test('local Chromium: desktop/mobile protected setup, CSP, callback cleanup and native SPA anchors', {
  skip: available ? false : 'Python Playwright is not installed',
  timeout: 60000,
}, () => {
  const program = String.raw`
import json, sys, threading
from datetime import datetime, timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

root = Path(sys.argv[1])
native = b'''<!doctype html><html lang="zh-Hant"><head><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/paseo/assets/setup.css"><script defer src="/paseo/entry.js"></script></head><body><main><section class="integrations-view" aria-labelledby="integrations-title"><header class="integrations-view__hero"><h1 id="integrations-title">Integrations</h1></header></section></main></body></html>'''
class Handler(BaseHTTPRequestHandler):
 def log_message(self, *_): pass
 def do_GET(self):
  files = {"/paseo/setup":("ui/setup.html","text/html; charset=utf-8"),"/paseo/assets/setup.js":("ui/setup.js","text/javascript"),"/paseo/assets/setup.css":("ui/setup.css","text/css"),"/paseo/entry.js":("ui/native-entry.js","text/javascript")}
  if self.path == "/native": content, kind = native, "text/html; charset=utf-8"
  elif self.path in files:
   relative, kind = files[self.path]; content = (root/relative).read_bytes()
  else: self.send_error(404); return
  self.send_response(200); self.send_header("Content-Type",kind); self.send_header("Cache-Control","no-store")
  self.send_header("Referrer-Policy","no-referrer"); self.send_header("X-Content-Type-Options","nosniff")
  self.send_header("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  self.end_headers(); self.wfile.write(content)
server=ThreadingHTTPServer(("127.0.0.1",0), Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
base="http://127.0.0.1:"+str(server.server_port)
status={"schemaVersion":1,"version":"0.11.2","phase":"running","desiredEnabled":True,
 "daemon":{"running":True,"reachable":True,"relayEnabled":True},
 "providers":[{"provider":provider,"status":"ready","authentication":"needs_chat_verification"} for provider in ["claude","codex","pi"]],
 "lastVerification":{"checkedAt":None,"providers":[]},"operation":None,"onboarding":{"url":"/project/p1?conversation=c1"}}
calls=[]
def bridge(route):
 request=route.request
 if request.method=="GET": result=status
 else:
  body=request.post_data_json; calls.append(body)
  action=body["action"]
  if action=="models":
   result={"provider":body["provider"],"models":[{"id":"live-model","label":"可用模型","isDefault":True}],"modes":[{"id":"safe","label":"安全模式"}],"defaultModeId":"safe"}
  elif action=="pair": result={"url":"https://app.paseo.sh/#offer=SAMPLE_ONLY"}
  elif action=="login":
   if body["step"]=="complete": result={"provider":"pi","phase":"authorization_completed"}
   else: result={"provider":"pi","phase":"awaiting_authorization","requiresCode":True,"inputKind":"redirect_url_or_code","authorizationUrl":"https://auth.openai.com/oauth/authorize?state=SAMPLE_ONLY"}
  elif action=="acceptance":
   result={"checkedAt":datetime.now(timezone.utc).isoformat(),"passed":True,"providers":[{"provider":body["providers"][0],"model":body["models"][body["providers"][0]],"modeId":body["modes"][body["providers"][0]],"firstReply":True,"followup":True,"passed":True}]}
  else: result=status
 route.fulfill(status=200,content_type="application/json",body=json.dumps(result))
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=["--no-sandbox"])
 cold_context=browser.new_context(viewport={"width":390,"height":844})
 cold_page=cold_context.new_page()
 cold={**status,"pluginInstalled":False,"installed":False,"phase":"disabled","desiredEnabled":False,"version":None}
 native_imports=[]
 cold_page.route("**/api/paseo-bridge",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(cold)))
 def native_import(route):
  assert route.request.method=="POST"
  assert route.request.post_data_json=={"source":"https://github.com/WOOWTECH/opendesign-paseo-plugin"}
  native_imports.append(True);cold["pluginInstalled"]=True;cold["phase"]="installing"
  route.fulfill(status=200,content_type="text/event-stream",body='event: installed\ndata: {}\n\n')
 cold_page.route("**/api/plugins/install",native_import)
 cold_page.goto(base+"/paseo/setup")
 expect(cold_page.locator("#import-plugin")).to_be_visible()
 expect(cold_page.locator("#enable")).to_be_disabled()
 cold_page.get_by_role("button",name="首次安裝連線插件",exact=True).click()
 expect(cold_page.locator("#import-plugin")).to_be_hidden()
 assert len(native_imports)==1
 assert cold_page.evaluate("() => document.documentElement.scrollWidth <= innerWidth")
 cold_context.close()

 for width,height in [(1280,900),(390,844)]:
  context=browser.new_context(viewport={"width":width,"height":height})
  context.route("**/*",lambda route: route.continue_() if route.request.url.startswith(base+"/") else route.abort())
  page=context.new_page()
  page.route("**/api/paseo-bridge",bridge)
  errors=[]; page.on("pageerror",lambda error: errors.append(str(error)))
  response=page.goto(base+"/paseo/setup",wait_until="domcontentloaded")
  assert response.headers["content-security-policy"] == "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  page.get_by_role("button",name="讀取可用模型",exact=True).click()
  expect(page.locator("#model")).to_have_value("live-model")
  assert page.locator("#model").input_value()=="live-model"
  assert page.locator("#mode").input_value()=="safe"
  assert page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), "viewport overflows"
  page.screenshot(path="/tmp/opendesign-paseo-gui-"+str(width)+".png",full_page=True)
  page.locator("#provider").select_option("pi")
  page.get_by_role("button",name="登入與帳號設定",exact=True).click()
  field=page.get_by_label("授權回呼網址或代碼",exact=True)
  field.fill("SAMPLE_CALLBACK")
  page.get_by_role("button",name="提交授權結果",exact=True).click()
  page.locator("#login-message").filter(has_text="官方登入流程已完成").wait_for()
  assert field.input_value()==""
  assert not field.is_visible()
  assert page.evaluate("() => Object.keys(localStorage).length+Object.keys(sessionStorage).length")==0
  page.get_by_role("button",name="讀取可用模型",exact=True).click()
  page.get_by_role("button",name="測試選定模型",exact=True).click()
  page.locator("#test-result").filter(has_text="本次已取得兩輪").wait_for()
  page.get_by_role("button",name="建立配對連結",exact=True).click()
  page.locator("#pair-link").wait_for(state="visible")
  assert page.locator("#pair-link").get_attribute("href").startswith("https://app.paseo.sh/")
  page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
  assert page.locator("#pair-link").get_attribute("href") is None
  assert not page.locator("#pair-panel").is_visible()
  assert not errors, "browser script failed"
  context.close()
 context=browser.new_context()
 context.route("**/*",lambda route: route.continue_() if route.request.url.startswith(base+"/") else route.abort())
 page=context.new_page()
 native_record={"id":"woowtech-paseo","manifest":{"name":"woowtech-paseo"},"source":"github:WOOWTECH/opendesign-paseo-plugin"}
 page.route("**/api/plugins/woowtech-paseo",lambda route:route.fulfill(status=200,content_type="application/json",body=json.dumps(native_record)))
 page.goto(base+"/native")
 page.get_by_role("link",name="安裝與連線設定",exact=True).wait_for()
 assert page.locator(".paseo-native-entry").count()==1
 assert page.get_by_role("link",name="安裝與連線設定",exact=True).get_attribute("href")=="/paseo/setup"
 page.evaluate("""() => {
 const old=document.querySelector('.integrations-view');
 old.remove();
 const section=document.createElement('section');
 section.className='integrations-view';
 section.setAttribute('aria-labelledby','integrations-title');
 const header=document.createElement('header'); header.className='integrations-view__hero';
 section.appendChild(header);document.querySelector('main').appendChild(section);
 }""")
 page.get_by_role("link",name="安裝與連線設定",exact=True).wait_for()
 assert page.locator(".paseo-native-entry").count()==1
 page.evaluate("() => document.querySelector('main').replaceChildren()")
 page.locator(".paseo-native-entry").wait_for(state="detached")
 context.close(); browser.close()
server.shutdown()
assert all("password" not in body and "token" not in body for body in calls)
print(json.dumps({"viewports":[1280,390],"csp":"external-only","nativeRemount":True,"callbackCleared":True,"pairingCleared":True,"externalRequests":"blocked"}))
`;
  const result = spawnSync('python3', ['-c', program, root], { encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024 });
  const failure = result.stderr?.includes('unsafe-eval') ? 'CSP_EVAL_BLOCKED' : result.error?.code || 'UI_BROWSER_CHECK_FAILED';
  assert.equal(result.status, 0, failure);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual(report.viewports, [1280, 390]);
  assert.equal(report.nativeRemount, true);
  assert.equal(report.callbackCleared, true);
});
