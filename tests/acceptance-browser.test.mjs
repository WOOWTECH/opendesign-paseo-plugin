import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/browser-acceptance.py', import.meta.url));
const bootstrap = `
import sys, importlib.util
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('acceptance', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

test('Python phase/credential/privacy guards fail closed without opening a browser', async () => {
  const { stdout } = await run('python3', ['-c', bootstrap + `
import json, tempfile, os
from pathlib import Path
from types import SimpleNamespace
def rejects(call, code):
 try:
  call()
 except module.AcceptanceError as error:
  assert error.code == code
 else:
  raise AssertionError('guard did not reject')
assert module.parse_args([]).phase == 'status'
assert str(module.PRIVATE_ROOT) == os.environ.get('OPENDESIGN_PASEO_ACCEPTANCE_PRIVATE_ROOT',str(Path.home()/'.private'/'opendesign-paseo'))
rejects(lambda: module.private_path('/tmp/fake.json',root='relative-root'), 'ACCEPTANCE_PRIVATE_ROOT_REQUIRED')
rejects(lambda: module.authorized_target({'base':'https://fixture.invalid'},{}), 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED')
rejects(lambda: module.parse_args(['--phase','pair']), 'ACCEPTANCE_MUTATION_NOT_ALLOWED')
rejects(lambda: module.parse_args(['--password','secret']), 'ACCEPTANCE_INVALID_ARGUMENT')
rejects(lambda: module.signed_in_providers({'credentialPresent':True}), 'ACCEPTANCE_SIGNED_IN_PROVIDERS_REQUIRED')
rejects(lambda: module.signed_in_providers({'signedInProviders':['claude','claude']}), 'ACCEPTANCE_SIGNED_IN_PROVIDERS_REQUIRED')
assert module.signed_in_providers({'signedInProviders':['claude']}) == ['claude']
for base in ['http://example.test','https://u:p@example.test','https://example.test/?token=secret','https://example.test/#secret']:
 rejects(lambda: module.target_origin({'base':base}), 'ACCEPTANCE_INVALID_TARGET')
assert module.safe_code(Exception('raw password=secret')) == 'ACCEPTANCE_FAILED'
with tempfile.TemporaryDirectory(prefix='od-acceptance-private-') as temporary:
 root=Path(temporary)
 config=root/'config.json'
 config.write_text('{"signedInProviders":["claude"]}')
 os.chmod(config,0o600)
 assert module.read_private_json(config,root=root)['signedInProviders'] == ['claude']
 (root/'link.json').symlink_to(config)
 rejects(lambda: module.read_private_json(root/'link.json',root=root), 'ACCEPTANCE_UNSAFE_PATH')
 os.chmod(config,0o644)
 rejects(lambda: module.read_private_json(config,root=root), 'ACCEPTANCE_PRIVATE_FILE_PERMISSIONS')
 rejects(lambda: module.private_path(root/'../public.json',root), 'ACCEPTANCE_PRIVATE_PATH_REQUIRED')
 module.write_private_json(root/'evidence/test.json',{'passed':True},root=root)
 assert (root/'evidence/test.json').stat().st_mode & 0o777 == 0o600
assert module.plugin_records({'plugins':[{'id':'woowtech-paseo'},{'id':'other'}]}) == [{'id':'woowtech-paseo'}]
assert module.plugin_records({'plugins':[{'entry':{'name':'woowtech-paseo'}}]}) == [{'entry':{'name':'woowtech-paseo'}}]
print(json.dumps({'passed':True}))
`, script], { timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { passed: true });
});

test('request guard bounds mutations to the selected phase, bridge/import, and official App', async () => {
  const { stdout } = await run('python3', ['-c', bootstrap + `
import json
origin='https://tenant.test'
target={'base':origin,'workspaceId':101,'serviceId':202,'namespace':'fixture-namespace','release':'fixture-release'}
authorized={'baseOrigin':origin,**{k:v for k,v in target.items() if k!='base'}}
def allowed(method,url,phase='status',mutations=False):
 return module.can_mutate_request(method,url,origin=origin,phase=phase,allowed=mutations,target=target,authorized=authorized)
assert allowed('GET',origin+'/api/paseo-bridge')
assert not module.can_mutate_request('POST',origin+'/api/paseo-bridge',origin=origin,phase='enable',allowed=True)
for key in authorized:
 mismatch={**authorized,key: 'other-target'}
 assert not module.can_mutate_request('POST',origin+'/api/paseo-bridge',origin=origin,phase='enable',allowed=True,target=target,authorized=mismatch)
assert not module.can_mutate_request('POST',origin+'/api/paseo-bridge',origin='https://other.test',phase='enable',allowed=True,target=target,authorized=authorized)
assert not allowed('POST',origin+'/api/paseo-bridge')
assert not allowed('POST',origin+'/api/paseo-bridge',mutations=True)
assert allowed('POST',origin+'/api/paseo-bridge',phase='enable',mutations=True)
assert not allowed('POST',origin+'/api/projects',phase='enable',mutations=True)
assert allowed('POST',origin+'/api/plugins/install',phase='install',mutations=True)
assert not allowed('POST',origin+'/api/plugins/install',phase='enable',mutations=True)
assert allowed('POST','https://app.paseo.sh/api/pair',phase='pair',mutations=True)
assert not allowed('POST','https://app.paseo.sh.evil.test/api/pair',phase='pair',mutations=True)
assert not allowed('POST','https://app.paseo.sh/api/pair',phase='status',mutations=True)
assert not allowed('POST','https://other.test/api/pair',phase='ui-chat',mutations=True)
assert module.can_mutate_request('POST',origin+'/api/paseo-bridge',origin=origin,phase='models',allowed=False,body='{"action":"models","provider":"claude"}')
assert not module.can_mutate_request('POST',origin+'/api/paseo-bridge',origin=origin,phase='models',allowed=False,body='{"action":"enable","provider":"claude"}')
assert not module.can_mutate_request('POST',origin+'/api/paseo-bridge',origin=origin,phase='models',allowed=False,body='{"action":"models","provider":"claude","extra":"x"}')
print(json.dumps({'passed':True}))
`, script], { timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { passed: true });
});

test('real Chromium blocks read-only writes, bounds enabled writes, and masks screenshot secrets', { timeout: 60000 }, async t => {
  const posts = [];
  let upgrades = 0;
  const tlsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-tls-fixture-'));
  t.after(() => fs.rmSync(tlsRoot, { recursive: true, force: true }));
  const key = path.join(tlsRoot, 'key.pem'), cert = path.join(tlsRoot, 'cert.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 15000 });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    if (req.method === 'POST') { posts.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body style="margin:0"><div id="pair-panel" style="width:300px;height:50px;background:red">https://app.paseo.sh/pair?token=secret-one</div><input value="secret-one" style="width:300px"><span id="secret" style="display:block;width:300px;height:30px">secret-one</span><button id="bridge" onclick="fetch('/api/paseo-bridge',{method:'POST'}).catch(()=>{})">bridge</button><button id="unrelated" onclick="fetch('/api/projects',{method:'POST'}).catch(()=>{})">unrelated</button></body></html>`);
  });
  server.on('upgrade', (_req, socket) => { upgrades++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `https://127.0.0.1:${server.address().port}`;
  let result;
  try {
    result = await run('python3', ['-c', bootstrap + `
import asyncio, tempfile, json, hashlib
from pathlib import Path
from types import SimpleNamespace
from playwright.async_api import async_playwright
async def check():
 with tempfile.TemporaryDirectory(prefix='od-acceptance-browser-') as temporary:
  private=Path(temporary)
  original_private_path=module.private_path
  module.private_path=lambda file,root=private: original_private_path(file,root)
  args=SimpleNamespace(phase='status',allow_mutation=False)
  target={'base':sys.argv[2],'workspaceId':101,'serviceId':202,'namespace':'fixture-namespace','release':'fixture-release'}
  config={'authorizedTarget':{'baseOrigin':sys.argv[2],**{k:v for k,v in target.items() if k!='base'}}}
  harness=module.Harness(args,config,target,{'username':'fixture','password':'secret-one'})
  harness.secrets=['secret-one','secret-two']
  harness.screenshot_dir=private/'screenshots'
  async with async_playwright() as playwright:
   browser=await playwright.chromium.launch(headless=True)
   try:
    context=await browser.new_context(viewport={'width':500,'height':300},service_workers='block',ignore_https_errors=True)
    await context.route('**/*',harness.guard)
    await context.route_web_socket('**/*',harness.guard_socket)
    page=await context.new_page()
    await page.goto(harness.origin)
    await page.locator('#bridge').click()
    await page.wait_for_timeout(150)
    assert harness.events['blockedWrites'] == 1
    # Even --allow-mutation on a read-only phase must block writes.
    args.allow_mutation=True
    await page.locator('#bridge').click()
    await page.wait_for_timeout(150)
    assert harness.events['blockedWrites'] == 2
    args.phase='enable'
    await page.locator('#bridge').click()
    await page.locator('#unrelated').click()
    await page.wait_for_timeout(150)
    assert harness.events['blockedWrites'] == 3
    original_evaluate=page.evaluate
    async def checked_evaluate(expression,arg=None):
     assert 'secret-one' not in json.dumps(arg) and 'secret-two' not in json.dumps(arg)
     return await original_evaluate(expression,arg)
    page.evaluate=checked_evaluate
    await harness.screenshot(page,'one')
    await page.evaluate("() => {document.querySelector('input').value='secret-two';document.querySelector('#secret').textContent='secret-two';document.querySelector('#pair-panel').textContent='https://app.paseo.sh/pair?token=secret-two'}")
    await harness.screenshot(page,'two')
    one=(private/'screenshots/one.png').read_bytes()
    two=(private/'screenshots/two.png').read_bytes()
    assert hashlib.sha256(one).digest() == hashlib.sha256(two).digest()
    assert (private/'screenshots/one.png').stat().st_mode & 0o777 == 0o600
    await page.evaluate("origin => new WebSocket(origin.replace('http','ws')+'/api/ws')",harness.origin)
    await page.wait_for_timeout(150)
    assert harness.events['blockedSockets'] == 1
    print(json.dumps({'passed':True,'maskedScreenshotsStable':True,'blockedWrites':harness.events['blockedWrites'],'blockedSockets':harness.events['blockedSockets']}))
   finally:
    await browser.close()
asyncio.run(check())
`, script, origin], { timeout: 50000 });
  } catch {
    // Never echo Playwright exceptions (may include page URLs, request data or auth).
    assert.fail('Local Playwright verification failed; install Python Playwright and its Chromium binary before rerunning.');
  }
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, maskedScreenshotsStable: true, blockedWrites: 3, blockedSockets: 1 });
  assert.deepEqual(posts, ['/api/paseo-bridge']);
  assert.equal(upgrades, 0);
});

test('actual setup HTML/JS renders protected diagnostics, three POST catalogs and mobile without writes', { timeout: 60000 }, async t => {
  const base = new URL('../ui/', import.meta.url);
  const assets = {
    '/paseo/setup': { type: 'text/html', body: fs.readFileSync(new URL('setup.html', base)) },
    '/paseo/assets/setup.js': { type: 'text/javascript', body: fs.readFileSync(new URL('setup.js', base)) },
    '/paseo/assets/setup.css': { type: 'text/css', body: fs.readFileSync(new URL('setup.css', base)) },
  };
  const writeActions = [], catalogs = [];
  const status = {
    schemaVersion: 1, version: '0.11.2', installed: true, phase: 'running', desiredEnabled: true,
    daemon: { owned: true, ready: true, running: true, reachable: true },
    providers: ['claude', 'codex', 'pi'].map(provider => ({ provider, status: 'ready', authentication: 'needs_chat_verification' })),
    onboarding: { id: 'fixture-onboarding', conversationId: 'fixture-onboarding', url: '/projects/test/conversations/fixture-onboarding' },
  };
  const server = http.createServer(async (req, res) => {
    if (!req.headers.authorization) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="Fixture"'); res.end('Authentication required'); return; }
    const route = new URL(req.url, 'http://fixture.invalid').pathname;
    if (assets[route]) { res.setHeader('Content-Type', assets[route].type); res.end(assets[route].body); return; }
    if (route === '/api/paseo-bridge') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') { res.end(JSON.stringify(status)); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      let value;
      try { value = JSON.parse(body); } catch { res.statusCode = 400; res.end('{}'); return; }
      if (value.action === 'models') {
        catalogs.push(value.provider);
        res.end(JSON.stringify({ provider: value.provider, defaultModeId: value.provider === 'pi' ? null : 'default', modes: value.provider === 'pi' ? [] : [{ id: 'default', label: 'Default' }], models: [{ id: `${value.provider}-fixture-model`, label: `${value.provider} fixture`, isDefault: true }] }));
      } else { writeActions.push(value.action); res.statusCode = 400; res.end('{}'); }
      return;
    }
    res.statusCode = 404; res.end('');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let result;
  try {
    result = await run('python3', ['-c', bootstrap + `
import asyncio, tempfile, json
from pathlib import Path
from types import SimpleNamespace
from playwright.async_api import async_playwright
async def check():
 with tempfile.TemporaryDirectory(prefix='od-acceptance-ui-') as temporary:
  private=Path(temporary)
  original_private_path=module.private_path
  module.private_path=lambda file,root=private: original_private_path(file,root)
  args=SimpleNamespace(phase='status',allow_mutation=False)
  harness=module.Harness(args,{}, {'base':'https://fixture.invalid'}, {'username':'fixture','password':'fixture-password'})
  harness.origin=sys.argv[2]
  harness.screenshot_dir=private/'screenshots'
  async with async_playwright() as playwright:
   browser=await playwright.chromium.launch(headless=True)
   harness.browser=browser
   try:
    harness.context=await browser.new_context(http_credentials={'username':'fixture','password':'fixture-password','origin':harness.origin},viewport={'width':1440,'height':1000},service_workers='block')
    await harness.context.route('**/*',harness.guard)
    harness.page=await harness.context.new_page()
    harness.page.set_default_timeout(5000)
    harness.page.on('pageerror',lambda _: harness.events.__setitem__('pageErrors',harness.events['pageErrors']+1))
    await harness.status()
    assert harness.evidence['unauthenticatedDenied']
    assert all(row['present'] for row in harness.evidence['status']['providers'])
    args.phase='models'
    await harness.models()
    assert len(harness.evidence['providers']) == 3
    assert all(row['selectionConfirmed'] for row in harness.evidence['providers'])
    assert next(row for row in harness.evidence['providers'] if row['provider']=='pi')['modeCount'] == 0
    args.phase='mobile'
    await harness.mobile()
    assert all(row['passed'] for row in harness.evidence['viewports'])
    assert harness.events['pageErrors'] == 0
    assert harness.events['blockedWrites'] == 0
    print(json.dumps({'passed':True,'models':3,'mobileWidths':4,'protected':True}))
   finally:
    await browser.close()
asyncio.run(check())
`, script, `http://127.0.0.1:${server.address().port}`], { timeout: 50000 });
  } catch {
    assert.fail('Actual setup UI acceptance fixture failed; check GUI syntax/contracts and local Playwright prerequisites. No raw browser errors retained.');
  }
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, models: 3, mobileWidths: 4, protected: true });
  assert.deepEqual(catalogs, ['claude', 'codex', 'pi']);
  assert.deepEqual(writeActions, []);
});

test('actual setup acceptance omits Pi zero modes and strictly validates catalog, UI state and fresh receipt selection', { timeout: 60000 }, async t => {
  const assets = Object.fromEntries([
    ['/paseo/setup', 'text/html', 'setup.html'],
    ['/paseo/assets/setup.js', 'text/javascript', 'setup.js'],
    ['/paseo/assets/setup.css', 'text/css', 'setup.css'],
  ].map(([route, type, file]) => [route, { type, body: fs.readFileSync(new URL('../ui/' + file, import.meta.url)) }]));
  const cases = [
    { name: 'pi-omitted', provider: 'pi' },
    { name: 'pi-null', provider: 'pi', mode: null },
    { name: 'pi-blank', provider: 'pi', mode: '' },
    { name: 'pi-unknown-mode', provider: 'pi', mode: 'default', code: 'ACCEPTANCE_INVALID_MODE' },
    { name: 'pi-missing-model', provider: 'pi', model: '', code: 'ACCEPTANCE_EXPLICIT_UI_SELECTION_REQUIRED' },
    { name: 'pi-unknown-model', provider: 'pi', model: 'unknown', code: 'ACCEPTANCE_INVALID_MODEL' },
    { name: 'pi-invalid-default', provider: 'pi', defaultModeId: 'unsupported', code: 'ACCEPTANCE_INVALID_MODE' },
    { name: 'pi-mode-enabled', provider: 'pi', modeEnabled: true, code: 'ACCEPTANCE_MODE_UI_MISMATCH' },
    { name: 'pi-stale-receipt', provider: 'pi', stale: true, code: 'ACCEPTANCE_FRESH_RECEIPT_REQUIRED', request: true },
    { name: 'pi-wrong-receipt-mode', provider: 'pi', receiptMode: '', code: 'ACCEPTANCE_GUI_TEST_FAILED', request: true },
    { name: 'pi-wrong-receipt-model', provider: 'pi', receiptModel: 'other', code: 'ACCEPTANCE_GUI_TEST_FAILED', request: true },
    { name: 'claude-default', provider: 'claude', mode: 'default' },
    { name: 'claude-missing-mode', provider: 'claude', code: 'ACCEPTANCE_MODE_REQUIRED' },
    { name: 'claude-unknown-mode', provider: 'claude', mode: 'unknown', code: 'ACCEPTANCE_INVALID_MODE' },
  ];
  const requests = [];
  const tlsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-selection-tls-'));
  t.after(() => fs.rmSync(tlsRoot, { recursive: true, force: true }));
  const key = path.join(tlsRoot, 'key.pem'), cert = path.join(tlsRoot, 'cert.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 15000 });
  const status = {
    schemaVersion: 1, version: '0.11.2', installed: true, phase: 'running', desiredEnabled: true,
    daemon: { owned: true, ready: true, running: true, reachable: true },
    providers: ['claude', 'codex', 'pi'].map(provider => ({ provider, status: 'ready', authentication: 'needs_chat_verification' })),
    onboarding: { id: 'fixture-onboarding' },
    lastVerification: { checkedAt: '2000-01-01T00:00:00.000Z', providers: [] },
  };
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    if (!req.headers.authorization) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="Fixture"'); res.end('Authentication required'); return; }
    const route = new URL(req.url, 'https://fixture.invalid').pathname;
    if (assets[route]) { res.setHeader('Content-Type', assets[route].type); res.end(assets[route].body); return; }
    if (route !== '/api/paseo-bridge') { res.statusCode = 404; res.end(''); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify(status)); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body), fixture = cases.find(row => row.name === req.headers['x-fixture-scenario']);
    if (!fixture) { res.statusCode = 400; res.end('{}'); return; }
    requests.push({ scenario: fixture.name, value });
    if (value.action === 'models') {
      res.end(JSON.stringify({ provider: value.provider, models: [{ id: `${value.provider}-fixture-model`, label: 'Fixture model' }],
        modes: value.provider === 'pi' ? [] : [{ id: 'default', label: 'Default' }],
        defaultModeId: fixture.defaultModeId ?? (value.provider === 'pi' ? null : 'default') }));
    } else if (value.action === 'acceptance') {
      res.end(JSON.stringify({ checkedAt: fixture.stale ? status.lastVerification.checkedAt : new Date().toISOString(),
        providers: [{ provider: fixture.provider, model: fixture.receiptModel ?? `${fixture.provider}-fixture-model`,
          modeId: Object.hasOwn(fixture, 'receiptMode') ? fixture.receiptMode : fixture.provider === 'pi' ? null : 'default',
          passed: true, firstReply: true, followup: true, cleanup: { archived: true } }] }));
    } else { res.statusCode = 400; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `https://127.0.0.1:${server.address().port}`;
  let result;
  try {
    result = await run('python3', ['-c', bootstrap + `
import asyncio, tempfile, json
from pathlib import Path
from types import SimpleNamespace
from playwright.async_api import async_playwright
async def check():
 with tempfile.TemporaryDirectory(prefix='od-acceptance-selection-') as temporary:
  private=Path(temporary)
  original_private_path=module.private_path
  module.private_path=lambda file,root=private: original_private_path(file,root)
  origin=sys.argv[2]
  target={'base':origin,'workspaceId':101,'serviceId':202,'namespace':'fixture-namespace','release':'fixture-release'}
  async with async_playwright() as playwright:
   browser=await playwright.chromium.launch(headless=True)
   try:
    outcomes=[]
    for fixture in json.loads(sys.argv[3]):
     provider=fixture['provider']
     config={'authorizedTarget':{'baseOrigin':origin,**{k:v for k,v in target.items() if k!='base'}},'signedInProviders':[provider],
       'models':{provider:fixture.get('model',provider+'-fixture-model')}}
     if 'mode' in fixture: config['modes']={provider:fixture['mode']}
     harness=module.Harness(SimpleNamespace(phase='acceptance',allow_mutation=True),config,target,{'username':'fixture','password':'fixture-only'})
     harness.screenshot_dir=private/fixture['name']
     harness.context=await browser.new_context(http_credentials={'username':'fixture','password':'fixture-only','origin':origin},
       extra_http_headers={'X-Fixture-Scenario':fixture['name']},ignore_https_errors=True,service_workers='block')
     await harness.context.route('**/*',harness.guard)
     harness.page=await harness.context.new_page()
     harness.page.set_default_timeout(3000)
     if fixture.get('modeEnabled'):
      original_setup=harness.setup
      async def altered_setup():
       await original_setup()
       await harness.page.evaluate("() => document.querySelector('#model').addEventListener('change',()=>{document.querySelector('#mode').disabled=false})")
      harness.setup=altered_setup
     code=None
     try: await harness.acceptance()
     except module.AcceptanceError as error: code=error.code
     assert code == fixture.get('code'), fixture['name']+': '+str(code)
     if not code:
      row=harness.evidence['providers'][0]
      assert row['passed'] and row['model'] == provider+'-fixture-model'
      assert row['modeId'] == ('default' if provider=='claude' else None)
      if provider=='pi':
       assert await harness.page.locator('#mode').is_disabled()
       assert await harness.page.locator('#mode').input_value() == ''
     assert harness.events['blockedWrites'] == 0
     outcomes.append({'name':fixture['name'],'code':code})
     await harness.context.close()
    print(json.dumps({'passed':True,'cases':len(outcomes),'piModesOmitted':True}))
   finally: await browser.close()
asyncio.run(check())
`, script, origin, JSON.stringify(cases)], { timeout: 50000 });
  } catch {
    assert.fail('Local setup selection fixture failed; no raw browser errors or credentials retained.');
  }
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, cases: cases.length, piModesOmitted: true });
  for (const fixture of cases) {
    const writes = requests.filter(row => row.scenario === fixture.name && row.value.action === 'acceptance');
    assert.equal(writes.length, !fixture.code || fixture.request ? 1 : 0, fixture.name);
    if (writes.length) {
      assert.deepEqual(writes[0].value.models, { [fixture.provider]: `${fixture.provider}-fixture-model` });
      assert.deepEqual(writes[0].value.providers, [fixture.provider]);
      if (fixture.provider === 'pi') assert.equal(Object.hasOwn(writes[0].value, 'modes'), false);
      else assert.deepEqual(writes[0].value.modes, { claude: 'default' });
    }
  }
});

test('verified native Add/import controls and scoped Integrations entry work with retained native sections', { timeout: 30000 }, async () => {
  const template = (await import('../scripts/acceptance-config.mjs')).acceptanceConfigTemplate();
  const { stdout } = await run('python3', ['-c', bootstrap + `
import asyncio,json
from types import SimpleNamespace
from playwright.async_api import async_playwright
async def check():
 harness=module.Harness(SimpleNamespace(phase='install',allow_mutation=False),{}, {'base':'https://native-fixture.example.test'}, {'username':'fixture','password':'fixture-only'})
 expected=json.loads(sys.argv[2])
 assert harness.native == {**module.NATIVE_SELECTORS,**expected}
 async with async_playwright() as playwright:
  browser=await playwright.chromium.launch(headless=True)
  try:
   context=await browser.new_context()
   await context.route('**/*',lambda route: route.abort())
   page=await context.new_page()
   page.set_default_timeout(2000)
   await page.set_content('''<!doctype html><section class="plugin-marketplace" aria-labelledby="plugin-marketplace-title"><button class="plugin-marketplace__create" onclick="document.querySelector('[role=dialog]').hidden=false">Add</button><article data-testid="plugins-card-woowtech-paseo"><aside data-paseo-entry="woowtech-paseo"><a href="/paseo/setup">plugin link</a></aside></article></section><section class="plugin-marketplace__create-panel" role="dialog" aria-labelledby="plugin-create-title" hidden><div class="plugin-marketplace__url-import-row"><input placeholder="https://github.com/owner/plugin-repo" oninput="document.querySelector('[data-testid=plugin-create-import-url]').disabled=!this.value.trim()"><button data-testid="plugin-create-import-url" disabled>Import and upload</button></div><button class="plugin-marketplace__create-primary">Start from a prompt</button></section><section class="integrations-view" aria-labelledby="integrations-title"><header class="integrations-view__hero"></header><aside data-paseo-entry="woowtech-paseo"><a href="/paseo/setup">integration link</a></aside></section>''')
   await page.locator(harness.native['importOpen']).click()
   await page.locator(harness.native['importInput']).wait_for(state='visible')
   submit=page.locator(harness.native['importSubmit'])
   assert await submit.is_disabled()
   await page.locator(harness.native['importInput']).fill('https://github.com/WOOWTECH/opendesign-paseo-plugin')
   assert await submit.is_enabled()
   assert await page.locator(harness.native['integrationEntry']).count()==1
   assert await page.locator(harness.native['integrationEntry']).inner_text()=='integration link'
   assert await page.locator(harness.native['pluginCard']).first.is_visible()
   print(json.dumps({'passed':True,'nativeImportReady':True,'integrationScoped':True}))
  finally:await browser.close()
asyncio.run(check())
`, script, JSON.stringify(template.native.selectors)], { timeout: 25000 });
  assert.deepEqual(JSON.parse(stdout), { passed: true, nativeImportReady: true, integrationScoped: true });
});

test('native verification switches default official scope to Expert suites/Personal before proving the card', { timeout: 30000 }, async () => {
  const { stdout } = await run('python3', ['-c', bootstrap + `
import asyncio,json
from types import SimpleNamespace
from playwright.async_api import async_playwright
async def check():
 h=module.Harness(SimpleNamespace(phase='native',allow_mutation=False),{}, {'base':'https://native-fixture.example.test'}, {'username':'fixture','password':'fixture-only'})
 plugins='''<!doctype html><section class="plugin-marketplace" aria-labelledby="plugin-marketplace-title"><div class="plugin-marketplace__switch"><button onclick="window.pluginMode=true;document.querySelector('article').hidden=!window.personal">Expert suites</button><button onclick="window.pluginMode=false;document.querySelector('article').hidden=true">Skills</button></div><button data-testid="plugins-tab-installed" onclick="window.personal=true;document.querySelector('article').hidden=!window.pluginMode">Personal</button><article data-testid="plugins-card-woowtech-paseo" hidden>Paseo</article><script>window.pluginMode=true;window.personal=false</script></section>'''
 integrations='''<!doctype html><section class="plugin-marketplace" hidden><aside data-paseo-entry="woowtech-paseo"><a href="/paseo/setup">hidden card entry</a></aside></section><section class="integrations-view" aria-labelledby="integrations-title"><header class="integrations-view__hero"></header><aside data-paseo-entry="woowtech-paseo"><a href="/paseo/setup">setup</a></aside></section>'''
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True)
  try:
   context=await browser.new_context(service_workers='block')
   async def route(r):
    path=module.urlsplit(r.request.url).path
    if r.request.method!='GET':raise AssertionError('native verification wrote to server')
    html={'/plugins':plugins,'/integrations':integrations,'/paseo/setup':'<main id="main">protected setup fixture</main>'}.get(path)
    if html is None:await r.abort()
    else:await r.fulfill(status=200,content_type='text/html',body=html)
   await context.route('**/*',route)
   h.page=await context.new_page();h.page.set_default_timeout(2000)
   async def native_get(allow_absent=False):return {'id':'woowtech-paseo'}
   async def screenshot(page,label):pass
   h.native_get=native_get;h.screenshot=screenshot
   await h.native_check()
   assert h.evidence['nativePluginConfirmed'] and h.evidence['nativePluginCardVisible'] and h.evidence['integrationEntryConfirmed']
   assert module.urlsplit(h.page.url).path=='/paseo/setup'
   print(json.dumps({'passed':True,'personalTabConfirmed':True}))
  finally:await browser.close()
asyncio.run(check())
`, script], { timeout: 25000 });
  assert.deepEqual(JSON.parse(stdout), { passed: true, personalTabConfirmed: true });
});

test('verified existing native install is reused without import or onboarding mutation; foreign record fails closed', async () => {
  const { stdout } = await run('python3', ['-c', bootstrap + `
import asyncio,json
from types import SimpleNamespace
async def check():
 h=module.Harness(SimpleNamespace(phase='install',allow_mutation=True),{}, {'base':'https://native-fixture.example.test'}, {'username':'fixture','password':'fixture-only'})
 class NoPageWrites:
  def __getattr__(self,name):raise AssertionError('reuse must not open import or write to page')
 h.page=NoPageWrites()
 calls=[]
 initial={'desiredEnabled':False,'pluginInstalled':True,'onboarding':{'id':'fixture-same-onboarding'}}
 async def bridge():calls.append('status');return initial
 async def native_check():calls.append('native-check')
 async def wait_state(enabled):assert enabled is False;calls.append('wait-status');return initial
 h.bridge=bridge;h.native_check=native_check;h.wait_state=wait_state
 class Response:
  status=200;ok=True
  async def json(self):return {'id':'woowtech-paseo','manifest':{'name':'woowtech-paseo'},'source':'github:WOOWTECH/opendesign-paseo-plugin'}
 class Request:
  response=Response()
  async def get(self,url,max_redirects):calls.append('native-get');return self.response
 request=Request();h.context=SimpleNamespace(request=request)
 await h.install()
 assert calls==['status','native-get','native-check','wait-status']
 assert h.evidence['nativeInstallReused'] is True and h.evidence['gitUrlImportConfirmed'] is False
 assert h.evidence['repeatInstallPreservedOnboarding'] is True
 async def foreign():return {'id':'woowtech-paseo','manifest':{'name':'woowtech-paseo'},'source':'github:other/foreign'}
 request.response.json=foreign
 try:await h.install()
 except module.AcceptanceError as e:assert e.code=='ACCEPTANCE_NATIVE_PLUGIN_SOURCE_MISMATCH'
 else:raise AssertionError('foreign record was reused')
 request.response.status=404;request.response.ok=False
 assert await h.native_get(allow_absent=True) is None
 print(json.dumps({'passed':True,'reuseWithoutMutation':True,'foreignRejected':True}))
asyncio.run(check())
`, script], { timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { passed: true, reuseWithoutMutation: true, foreignRejected: true });
});
