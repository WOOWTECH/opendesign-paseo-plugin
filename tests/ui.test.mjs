import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('ui/setup.html', root), 'utf8');
const script = fs.readFileSync(new URL('ui/setup.js', root), 'utf8');
const nativeScript = fs.readFileSync(new URL('ui/native-entry.js', root), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Element {
  constructor(tag = 'div', doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.attrs = new Map();
    this.listeners = new Map(); this.hidden = false; this.disabled = false; this._text = ''; this._value = '';
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  removeAttribute(key) { this.attrs.delete(key); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; this._text = ''; for (const child of children) this.appendChild(child); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
  emit(type, detail = {}) { for (const fn of this.listeners.get(type) || []) fn({ type, target: this, ...detail }); }
  click() { if (!this.disabled && !this.hidden) this.emit('click'); }
  focus() { this.doc.focused = this; }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } }
  get isConnected() { return this === this.doc?.body || !!this.parentElement?.isConnected; }
  matches(selector) {
    if (selector.startsWith('[data-testid=')) return this.getAttribute('data-testid') === 'plugins-card-woowtech-paseo';
    if (selector === 'section.integrations-view[aria-labelledby="integrations-title"]') return this.tagName === 'SECTION' && this.className === 'integrations-view' && this.getAttribute('aria-labelledby') === 'integrations-title';
    if (selector.startsWith('.')) return (this.className || '').split(' ').includes(selector.slice(1));
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(',').some(part => child.matches(part.trim())) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  insertAdjacentElement(position, entry) {
    assert.equal(position, 'afterend');
    const parent = this.parentElement; entry.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, entry);
  }
}
class Clock {
  constructor() { this.now = Date.parse('2026-10-12T04:00:00.000Z'); this.next = 0; this.tasks = new Map(); }
  set = (fn, ms) => { const id = ++this.next; this.tasks.set(id, { fn, at: this.now + ms }); return id; };
  clear = id => this.tasks.delete(id);
  async advance(ms) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= end);
      if (!next) break;
      this.now = next[1].at; this.tasks.delete(next[0]); next[1].fn(); await flush();
    }
    this.now = end; await flush();
  }
}
function fixture(code = script) {
  const clock = new Clock(), doc = new Element('document');
  doc.doc = doc; doc.hidden = false; doc.byId = new Map();
  doc.body = new Element('body', doc);
  doc.getElementById = id => doc.byId.get(id);
  doc.createElement = tag => new Element(tag, doc);
  doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1], doc);
    element.hidden = /\bhidden\b/.test(match[2]); element.disabled = /\bdisabled\b/.test(match[2]);
    doc.byId.set(match[3], element); doc.body.appendChild(element);
  }
  doc.byId.get('provider').value = 'claude';
  const win = new Element('window', doc); win.location = { origin: 'https://protected.example' };
  const calls = [], responses = [], forbidden = () => { throw new Error('secret persistence/logging used'); };
  for (const name of ['localStorage', 'sessionStorage', 'history']) Object.defineProperty(win, name, { get: forbidden });
  const observers = [];
  class Observer {
    constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
    notify(target = doc.body) { if (this.connected) this.fn([{ target }]); }
  }
  const FakeDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  };
  const context = vm.createContext({
    document: doc, window: win, URL, AbortController, MutationObserver: Observer, Date: FakeDate,
    setTimeout: clock.set, clearTimeout: clock.clear,
    console: new Proxy({}, { get: () => forbidden }),
    fetch: (url, options) => {
      calls.push({ url, ...options, json: options.body ? JSON.parse(options.body) : undefined });
      const result = responses.shift();
      if (!result) return Promise.reject(new Error('missing mock response'));
      return typeof result === 'function' ? result(url, options) : Promise.resolve(result);
    },
  });
  return {
    doc, win, clock, calls, responses, observers, $: id => doc.byId.get(id),
    start: () => vm.runInContext(code, context),
    response: (dto, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => dto }),
    async ready(dto = current()) { responses.push(this.response(dto)); this.start(); await flush(); },
    async click(id, dto, status = 200) { if (dto !== undefined) responses.push(this.response(dto, status)); this.$(id).click(); await flush(); },
  };
}
const current = (extra = {}) => ({
  schemaVersion: 1, version: '0.11.2', phase: 'running', desiredEnabled: true,
  daemon: { running: true, reachable: true, relayEnabled: true },
  providers: ['claude', 'codex', 'pi'].map(provider => ({ provider, status: 'ready', authentication: 'chat_verified', credentialPresent: true })),
  onboarding: { url: '/project/project1?conversation=conversation1' }, operation: null,
  lastVerification: {
    checkedAt: '2026-10-11T12:00:00.000Z', passed: true, historical: true,
    providers: [{ provider: 'claude', model: 'old-model', modeId: 'safe', passed: true, firstReply: true, followup: true }],
  },
  ...extra,
});
const catalog = provider => ({ provider, models: [{ id: 'available-small', label: '<img src=x onerror=bad()>', isDefault: false }, { id: 'available-default', label: '可用預設模型', isDefault: true }], modes: [{ id: 'safe', label: '安全模式' }, { id: 'review', label: '檢視模式' }], defaultModeId: 'safe' });
const completedTest = (overrides = {}) => ({ checkedAt: '2026-10-12T04:00:30.000Z', passed: true, historical: true,
  providers: [{ provider: 'claude', model: 'available-default', modeId: 'safe', passed: true, firstReply: true, followup: true, ...overrides }] });

test('external-only protected HTML, scoped CSS, portable least-capability native manifest', () => {
  assert.match(html, /lang="zh-Hant"/);
  assert.match(html, /\/paseo\/assets\/setup.js/);
  assert.doesNotMatch(html, /\bon\w+=|<script[^>]*>\s*[^<\s]|<style\b|type="password"/i);
  const css = fs.readFileSync(new URL('ui/setup.css', root), 'utf8');
  assert.doesNotMatch(css, /url\(|@import|^\s*(?:body|:root|a|button)\s*\{/m);
  const manifest = JSON.parse(fs.readFileSync(new URL('launcher/open-design.json', root)));
  assert.equal(manifest.name, 'woow-paseo');
  assert.equal(manifest.specVersion, '1.0.0');
  assert.equal(manifest.od.launch.path, '/paseo/setup/');
  assert.doesNotMatch(JSON.stringify(manifest), /installHook|postinstall|subprocess|command|env/);
  const skill = fs.readFileSync(new URL('launcher/SKILL.md', root), 'utf8');
  assert.match(skill, /name: woow-paseo/);
  assert.equal(manifest.od.engineRequirements, undefined);
  assert.equal(manifest.od.capabilities, undefined);

});

test('initial current status separates historical proof and ignores runtime secrets', async () => {
  const f = fixture();
  await f.ready(current({ state: { password: 'DO_NOT_RENDER', pairing: 'https://app.paseo.sh/#private' } }));
  assert.match(f.$('daemon').textContent, /目前檢查/);
  assert.match(f.$('history-time').textContent, /歷史紀錄/);
  assert.match(f.$('provider-claude').textContent, /帳號授權待確認/);
  assert.doesNotMatch(f.doc.body.textContent, /DO_NOT_RENDER|#private/);
  assert.equal(f.$('pair-link').getAttribute('href'), null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.$('model').disabled, true);
  assert.equal(f.$('onboarding-link').getAttribute('href'), '/project/project1?conversation=conversation1');
});

test('live model/mode catalog drives selected provider acceptance and resets on provider change', async () => {
  const f = fixture(); await f.ready();
  await f.click('models', catalog('claude'));
  assert.equal(f.$('model').value, 'available-default');
  assert.equal(f.$('mode').value, 'safe');
  assert.equal(f.$('acceptance').disabled, false);
  assert.equal(f.$('model').children[0].textContent, '<img src=x onerror=bad()>');
  f.$('mode').value = 'review';
  await f.click('acceptance', completedTest({ modeId: 'review' }));
  assert.deepEqual(f.calls.at(-1).json, { action: 'acceptance', providers: ['claude'], models: { claude: 'available-default' }, modes: { claude: 'review' } });
  f.$('provider').value = 'codex'; f.$('provider').emit('change');
  assert.equal(f.$('acceptance').disabled, true);
  await f.click('models', catalog('codex'));
  assert.deepEqual(f.calls.at(-1).json, { action: 'models', provider: 'codex' });
  f.$('provider').value = 'pi'; f.$('provider').emit('change');
  await f.click('models', catalog('pi'));
  assert.deepEqual(f.calls.at(-1).json, { action: 'models', provider: 'pi' });
});

test('incomplete follow-up never claims acceptance; completed replies do', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  await f.click('acceptance', completedTest({ followup: false }));
  assert.match(f.$('test-result').textContent, /尚未確認兩輪/);
  assert.doesNotMatch(f.$('history').textContent, /兩輪通過/);
  await f.click('acceptance', completedTest());
  assert.match(f.$('test-result').textContent, /本次已取得兩輪/);
});

test('provider billing failures explain native output limits without claiming a reply', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  await f.click('acceptance', completedTest({ passed: false, firstReply: false, followup: false, code: 'PROVIDER_QUOTA_EXHAUSTED' }));
  assert.match(f.$('test-result').textContent, /尚未確認兩輪/);
  assert.match(f.$('test-result').textContent, /額度不足/);
  assert.match(f.$('test-result').textContent, /降低輸出上限/);
});

test('old or mismatched direct acceptance cannot be called the selected current test', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  await f.click('acceptance', current().lastVerification);
  assert.match(f.$('test-result').textContent, /尚未確認/);
  await f.click('acceptance', completedTest({ model: 'other-model' }));
  assert.match(f.$('test-result').textContent, /尚未確認/);
});
test('late aborted GET authorization failure cannot poison a newer mutation', async () => {
  const f = fixture(); await f.ready();
  const stale = deferred(); f.responses.push(() => stale.promise); await f.click('refresh');
  const pair = deferred(); f.responses.push(() => pair.promise); await f.click('pair');
  stale.resolve(f.response({ error: 'old auth failure' }, 401)); await flush();
  pair.resolve(f.response({ url: 'https://app.paseo.sh/#offer=NEW' })); await flush();
  assert.equal(f.$('pair-panel').hidden, false);
  assert.equal(f.$('login').disabled, false);
});

test('unavailable catalog and malformed provider response clear actionable selections', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  await f.click('models', { provider: 'pi', models: [], modes: [] });
  assert.equal(f.$('acceptance').disabled, true);
  await f.click('models', { provider: 'claude', models: [], modes: [], defaultModeId: null });
  assert.match(f.$('notice').textContent, /沒有可用模型/);
});

test('polling stops during POST, prevents overlap and ignores a late aborted GET', async () => {
  const f = fixture(); await f.ready();
  const stale = deferred(); f.responses.push(() => stale.promise);
  await f.click('refresh');
  const mutation = deferred(); f.responses.push(() => mutation.promise);
  await f.click('disable');
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.$('pair').disabled, true);
  f.$('disable').click(); f.$('refresh').click();
  await f.clock.advance(30000);
  assert.equal(f.calls.length, 3);
  stale.resolve(f.response(current({ version: 'stale', phase: 'error' }))); await flush();
  assert.doesNotMatch(f.$('version').textContent, /stale/);
  mutation.resolve(f.response(current({ phase: 'disabled', desiredEnabled: false, daemon: { running: false, reachable: false } }))); await flush();
  assert.match(f.$('phase').textContent, /已停止/);
});

test('automatic polling is bounded and resumes only through explicit refresh', async () => {
  const f = fixture(); await f.ready();
  for (let i = 0; i < 20; i++) f.responses.push(f.response(current()));
  await f.clock.advance(15_000 * 25);
  assert.equal(f.calls.length, 21);
  assert.match(f.$('refresh-note').textContent, /自動更新已暫停/);
  await f.click('refresh', current());
  assert.equal(f.calls.length, 22);
});

test('pairing is official-only, transient, expires and never enters request queries', async () => {
  const f = fixture(); await f.ready();
  await f.click('pair', { url: 'https://app.paseo.sh/#offer=PRIVATE_PAIR' });
  assert.equal(f.$('pair-panel').hidden, false);
  assert.match(f.$('pair-link').getAttribute('href'), /PRIVATE_PAIR/);
  assert.equal(f.$('pair-link').textContent.includes('PRIVATE_PAIR'), false);
  for (let i = 0; i < 8; i++) f.responses.push(f.response(current()));
  await f.clock.advance(120000);
  assert.equal(f.$('pair-link').getAttribute('href'), null);
  assert.equal(f.$('pair-panel').hidden, true);
  assert.ok(f.calls.every(call => call.url === '/api/paseo-bridge'));
  for (const bad of ['https://app.paseo.sh.evil.example/#offer=x', 'https://evil.example/', 'https://user:pass@app.paseo.sh/#x', 'https://app.paseo.sh/?token=x', 'javascript:bad()']) {
    await f.click('pair', { url: bad });
    assert.equal(f.$('pair-link').getAttribute('href'), null);
  }
});

test('pair result arriving after page hide stays out of protected DOM', async () => {
  const f = fixture(); await f.ready();
  const pending = deferred(); f.responses.push(() => pending.promise);
  await f.click('pair');
  f.doc.hidden = true; f.doc.emit('visibilitychange');
  pending.resolve(f.response({ url: 'https://app.paseo.sh/#offer=LATE_SECRET' })); await flush();
  assert.equal(f.$('pair-link').getAttribute('href'), null);
  assert.equal(f.$('pair-panel').hidden, true);
  assert.doesNotMatch(f.doc.body.textContent, /LATE_SECRET/);
});

test('runtime structured official login, explicit completion, credential honesty, and Pi guide', async () => {
  const f = fixture(); await f.ready();
  f.$('provider').value = 'codex'; f.$('provider').emit('change');
  await f.click('login', { provider: 'codex', phase: 'awaiting_authorization', authorizationUrl: 'https://auth.openai.com/codex/device?state=TRANSIENT', deviceCode: 'ABCD-EFGH' });
  assert.deepEqual(f.calls.at(-1).json, { action: 'login', provider: 'codex', step: 'start' });
  assert.equal(f.$('login-panel').hidden, false);
  assert.match(f.$('login-code').textContent, /ABCD-EFGH/);
  await f.click('login-status', { provider: 'codex', phase: 'authorization_completed' });
  assert.equal(f.$('login-link').getAttribute('href'), null);
  assert.match(f.$('login-message').textContent, /登入流程已完成/);
  await f.click('login', { provider: 'codex', phase: 'credential_present' });
  assert.match(f.$('login-message').textContent, /仍需.*測試/);
  f.$('provider').value = 'pi'; f.$('provider').emit('change');
  await f.click('login', { provider: 'pi', phase: 'interactive_required' });
  assert.match(f.$('login-message').textContent, /尚未提供網頁登入/);
  assert.equal(f.$('login-link').getAttribute('href'), null);
});

test('Pi callback input appears only on explicit backend requirement, survives active progress polling and clears on completion', async () => {
  const f = fixture(); await f.ready();
  f.$('provider').value = 'pi'; f.$('provider').emit('change');
  const pending = { provider: 'pi', phase: 'awaiting_authorization', authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=SAMPLE', requiresCode: true, inputKind: 'redirect_url_or_code' };
  await f.click('login', pending);
  assert.equal(f.$('login-input').hidden, false);
  f.$('login-code-input').value = 'http://localhost:1455/auth/callback?code=SAMPLE';
  f.responses.push(f.response(pending));
  await f.clock.advance(5000);
  assert.equal(f.$('login-code-input').value, 'http://localhost:1455/auth/callback?code=SAMPLE');
  assert.deepEqual(f.calls.at(-1).json, { action: 'login', provider: 'pi', step: 'status' });
  await f.click('login-submit', { provider: 'pi', phase: 'authorization_completed' });
  assert.deepEqual(f.calls.at(-1).json, { action: 'login', provider: 'pi', step: 'complete', code: 'http://localhost:1455/auth/callback?code=SAMPLE' });
  assert.equal(f.$('login-code-input').value, '');
  assert.equal(f.$('login-input').hidden, true);
  const count = f.calls.length; await f.clock.advance(5000);
  assert.equal(f.calls.length, count);
});

test('manualCodeRequired alias, code length bound, cancellation and hiding remove input', async () => {
  const f = fixture(); await f.ready();
  f.$('provider').value = 'pi'; f.$('provider').emit('change');
  const pending = { provider: 'pi', phase: 'awaiting_authorization', manualCodeRequired: true };
  await f.click('login', pending);
  f.$('login-code-input').value = 'x'.repeat(2049);
  const count = f.calls.length; await f.click('login-submit');
  assert.equal(f.calls.length, count);
  assert.match(f.$('notice').textContent, /2,048/);
  f.$('login-code-input').value = 'SAMPLE';
  await f.click('login-cancel', { provider: 'pi', phase: 'cancelled' });
  assert.equal(f.$('login-code-input').value, '');
  await f.click('login', pending);
  f.$('login-code-input').value = 'SAMPLE';
  f.doc.hidden = true; f.doc.emit('visibilitychange');
  assert.equal(f.$('login-code-input').value, '');
  assert.equal(f.$('login-input').hidden, true);
  const afterHide = f.calls.length; await f.clock.advance(60000);
  assert.equal(f.calls.length, afterHide);
});

test('active auth polling serializes POSTs and never runs outside an active login', async () => {
  const f = fixture(); await f.ready();
  await f.clock.advance(5000); assert.equal(f.calls.length, 1);
  const pending = { provider: 'claude', phase: 'awaiting_authorization', authorizationUrl: 'https://claude.ai/oauth/authorize' };
  await f.click('login', pending);
  const slow = deferred(); f.responses.push(() => slow.promise);
  await f.clock.advance(5000);
  const count = f.calls.length; await f.clock.advance(15000);
  assert.equal(f.calls.length, count);
  slow.resolve(f.response({ provider: 'claude', phase: 'authorization_completed' })); await flush();
  await f.clock.advance(5000); assert.equal(f.calls.length, count);
});

test('login foreign URLs and raw server errors never display, auth loss stops polling', async () => {
  const f = fixture(); await f.ready();
  await f.click('login', { provider: 'claude', phase: 'awaiting_authorization', authorizationUrl: 'https://evil.example/?secret=RAW' });
  assert.equal(f.$('login-link').getAttribute('href'), null);
  await f.click('models', { message: 'PASSWORD_LEAK', error: 'RAW_EXCEPTION' }, 401);
  assert.match(f.$('notice').textContent, /重新登入/);
  assert.doesNotMatch(f.doc.body.textContent, /PASSWORD_LEAK|RAW_EXCEPTION/);
  const count = f.calls.length; await f.clock.advance(60000);
  assert.equal(f.calls.length, count);
});

test('status failure erases current claims while retaining labelled historical proof', async () => {
  const f = fixture(); await f.ready();
  await f.click('refresh', { error: 'raw provider token' }, 500);
  assert.match(f.$('daemon').textContent, /未確認/);
  assert.match(f.$('provider-claude').textContent, /未確認/);
  assert.match(f.$('history-time').textContent, /歷史紀錄/);
  assert.equal(f.$('pair').disabled, true);
  assert.doesNotMatch(f.doc.body.textContent, /raw provider token/);
});

test('HTTP 202 is progress only and GET operation completion unlocks controls', async () => {
  const f = fixture(); await f.ready(current({ phase: 'disabled', desiredEnabled: false, daemon: { running: false, reachable: false } }));
  await f.click('enable', { operation: { id: 'job1', action: 'enable', status: 'running' } }, 202);
  assert.match(f.$('notice').textContent, /已接收/);
  assert.equal(f.$('login').disabled, true);
  f.responses.push(f.response(current({ operation: { id: 'job1', action: 'enable', status: 'running' } })));
  await f.clock.advance(15000);
  assert.equal(f.$('login').disabled, true);
  f.responses.push(f.response(current({ operation: { id: 'job1', action: 'enable', status: 'completed' } })));
  await f.clock.advance(15000);
  assert.match(f.$('notice').textContent, /已完成/);
  assert.equal(f.$('login').disabled, false);
});

test('202 acceptance uses fresh matching provider/model/mode evidence, not previous pass', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  await f.click('acceptance', { operation: { id: 'job2', action: 'acceptance', status: 'running' } }, 202);
  assert.match(f.$('test-result').textContent, /正在進行/);
  f.responses.push(f.response(current({ operation: { id: 'job2', action: 'acceptance', status: 'completed' } })));
  await f.clock.advance(15000);
  assert.match(f.$('test-result').textContent, /尚未確認/);
});

test('safe onboarding preserves known native IDs and rejects secret/cross-origin URLs', async () => {
  const f = fixture(); await f.ready();
  await f.click('onboarding', { url: '/project/p1?conversationId=c1' });
  assert.equal(f.$('onboarding-link').getAttribute('href'), '/project/p1?conversationId=c1');
  for (const url of ['https://evil.example/project', '/project/p1?token=PRIVATE', '/project#pair', '//evil.example/']) {
    await f.click('onboarding', { url });
    assert.equal(f.$('onboarding-link').getAttribute('href'), null);
  }
});

test('timeout settles UI and pagehide aborts, clears links and prevents late rendering', async () => {
  const f = fixture(); await f.ready();
  const pending = deferred(); f.responses.push(() => pending.promise);
  await f.click('pair');
  await f.clock.advance(180000);
  assert.match(f.$('notice').textContent, /逾時/);
  assert.equal(f.$('refresh').disabled, false);
  const late = deferred(); f.responses.push(() => late.promise);
  await f.click('pair');
  f.win.emit('pagehide');
  assert.equal(f.calls.at(-1).signal.aborted, true);
  late.resolve(f.response({ url: 'https://app.paseo.sh/#secret=LATE' })); await flush();
  assert.equal(f.$('pair-link').getAttribute('href'), null);
});

function addNative(f, kind = 'integrations') {
  const section = new Element('section', f.doc);
  section.className = kind === 'integrations' ? 'integrations-view' : 'plugin-marketplace';
  section.setAttribute('aria-labelledby', kind === 'integrations' ? 'integrations-title' : 'plugin-marketplace-title');
  const target = new Element('div', f.doc);
  if (kind === 'integrations') target.className = 'integrations-view__hero';
  else target.setAttribute('data-testid', 'plugins-card-woowtech-paseo');
  section.appendChild(target); f.doc.body.appendChild(section);
  return { section, target };
}
const nativePlugin = { id: 'woowtech-paseo', manifest: { name: 'woowtech-paseo' }, source: 'github:WOOWTECH/opendesign-paseo-plugin' };

test('native entry exists only at pinned card/Integrations anchors, GET proves source, same-host link', async () => {
  const f = fixture(nativeScript);
  f.start(); await flush();
  assert.equal(f.calls.length, 0);
  const { section } = addNative(f);
  f.responses.push(f.response(nativePlugin));
  f.observers[0].notify(); await f.clock.advance(200);
  const entry = section.querySelector('.paseo-native-entry');
  assert.ok(entry);
  assert.equal(entry.querySelector('a').getAttribute('href'), '/paseo/setup');
  assert.equal(entry.querySelector('a').hidden, false);
  assert.equal(f.calls[0].url, '/api/plugins/woowtech-paseo');
  for (let i = 0; i < 20; i++) f.observers[0].notify();
  await f.clock.advance(200);
  assert.equal(section.querySelectorAll('.paseo-native-entry').length, 1);
  f.win.emit('pagehide');
  assert.equal(f.observers[0].connected, false);
});

test('native absent install uses exact source and verifies install after SSE EOF, no LLM', async () => {
  const f = fixture(nativeScript); const { section } = addNative(f, 'plugins');
  f.responses.push(f.response({}, 404)); f.start(); await flush();
  const entry = section.querySelector('.paseo-native-entry');
  assert.equal(entry.querySelector('button').hidden, false);
  let cancelled = false, read = false;
  f.responses.push({ ok: true, status: 200, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: new Uint8Array([1, 2]) }),
    cancel: async () => { cancelled = true; },
  }) } });
  f.responses.push(f.response(nativePlugin));
  entry.querySelector('button').click(); await flush();
  assert.deepEqual(f.calls[1].json, { source: 'github:WOOWTECH/opendesign-paseo-plugin' });
  assert.equal(f.calls[1].url, '/api/plugins/install');
  assert.equal(f.calls[2].url, '/api/plugins/woowtech-paseo');
  assert.equal(cancelled, true);
  assert.equal(entry.querySelector('a').hidden, false);
});

test('native foreign source and apparent successful install without registry proof fail closed', async () => {
  for (const initial of [{ ...nativePlugin, source: 'github:attacker/opendesign-paseo-plugin' }, null]) {
    const f = fixture(nativeScript); const { section } = addNative(f);
    f.responses.push(f.response(initial || {}, initial ? 200 : 404)); f.start(); await flush();
    const entry = section.querySelector('.paseo-native-entry');
    if (!initial) {
      f.responses.push({ ok: true, status: 200 });
      f.responses.push(f.response({}, 404));
      entry.querySelector('button').click(); await flush();
    }
    assert.equal(entry.querySelector('a').hidden, true);
    assert.equal(entry.querySelector('button').hidden, true);
    assert.match(entry.querySelector('p').textContent, /來源|無法確認/);
  }
});

test('every bridge request stays credentialed same-origin, no cache or redirect', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  for (const call of f.calls) {
    assert.equal(call.credentials, 'same-origin');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.redirect, 'error');
    assert.equal(call.url, '/api/paseo-bridge');
    assert.doesNotMatch(JSON.stringify(call.json || {}), /password|secret|authorization|token/);
  }
});


test('closing login information rejects an in-flight auth status response', async () => {
  const f = fixture(); await f.ready();
  f.$('provider').value = 'pi'; f.$('provider').emit('change');
  const pending = { provider: 'pi', phase: 'awaiting_authorization', requiresCode: true,
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=SAMPLE' };
  await f.click('login', pending);
  const late = deferred(); f.responses.push(() => late.promise);
  await f.clock.advance(5000);
  await f.click('login-close');
  late.resolve(f.response(pending)); await flush();
  assert.equal(f.$('login-panel').hidden, true);
  assert.equal(f.$('login-link').getAttribute('href'), null);
  const count = f.calls.length; await f.clock.advance(5000);
  assert.equal(f.calls.length, count);
});

test('reading the same model catalog preserves a valid model/mode selection', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  f.$('model').value = 'available-small'; f.$('mode').value = 'review';
  await f.click('models', catalog('claude'));
  assert.equal(f.$('model').value, 'available-small');
  assert.equal(f.$('mode').value, 'review');
});

test('a new login invalidates models from the previous account authorization', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  await f.click('login', { provider: 'claude', phase: 'credential_present' });
  assert.equal(f.$('acceptance').disabled, true);
  assert.equal(f.$('model').disabled, true);
});

test('async default mode resolves to the catalog default and verifies actual replies', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  f.$('mode').value = '';
  await f.click('acceptance', { scheduled: true, operation: { id: 'default-mode-job', action: 'acceptance', status: 'running', startedAt: '2026-10-12T04:00:00.000Z' } }, 202);
  assert.deepEqual(f.calls.at(-1).json.modes, { claude: 'safe' });
  f.responses.push(f.response(current({ lastVerification: completedTest(), operation: { id: 'default-mode-job', action: 'acceptance', status: 'completed' } })));
  await f.clock.advance(15000);
  assert.match(f.$('test-result').textContent, /本次已取得兩輪/);
});

test('async acceptance uses server operation time even when the browser clock is ahead', async () => {
  const f = fixture(); await f.ready(); await f.click('models', catalog('claude'));
  f.clock.now += 600000;
  await f.click('acceptance', { scheduled: true, operation: { id: 'clock-job', action: 'acceptance', status: 'running', startedAt: '2026-10-12T04:00:00.000Z' } }, 202);
  f.responses.push(f.response(current({ lastVerification: completedTest(), operation: { id: 'clock-job', action: 'acceptance', status: 'completed' } })));
  await f.clock.advance(15000);
  assert.match(f.$('test-result').textContent, /本次已取得兩輪/);
});

test('BFCache restoration discards a pre-hide models reply and refreshes current status', async () => {
  const f = fixture(); await f.ready();
  const late = deferred(); f.responses.push(() => late.promise); await f.click('models');
  f.win.emit('pagehide');
  f.responses.push(f.response(current())); f.win.emit('pageshow', { persisted: true }); await flush();
  late.resolve(f.response(catalog('claude'))); await flush();
  assert.equal(f.$('model').disabled, true);
  assert.equal(f.$('acceptance').disabled, true);
  assert.equal(f.calls.at(-1).method, 'GET');
});


test('missing bundled integration blocks activation without attempting a retired Git import', async () => {
 const h=fixture();await h.ready(current({installed:false,pluginInstalled:false,phase:'disabled',desiredEnabled:false}));
 assert.equal(h.$('enable').disabled,true);
 assert.equal(h.doc.byId.has('import-plugin'),false);
 assert.equal(h.calls.some(c=>c.url==='/api/plugins/install'),false);
});


test('returning from official authorization restores Pi input from fresh status without retaining secrets', async () => {
  const f = fixture(); await f.ready();
  f.$('provider').value = 'pi'; f.$('provider').emit('change');
  const pending = { provider: 'pi', phase: 'awaiting_authorization', requiresCode: true,
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=TRANSIENT_ONLY' };
  await f.click('login', pending);
  f.$('login-code-input').value = 'DO_NOT_RETAIN';
  f.doc.hidden = true; f.doc.emit('visibilitychange');
  assert.equal(f.$('login-link').getAttribute('href'), null);
  assert.equal(f.$('login-code-input').value, '');
  const count = f.calls.length;
  await f.clock.advance(30000);
  assert.equal(f.calls.length, count);
  const response = deferred(); f.responses.push(() => response.promise);
  f.doc.hidden = false; f.doc.emit('visibilitychange');
  await f.clock.advance(0);
  assert.deepEqual(f.calls.at(-1).json, { action: 'login', provider: 'pi', step: 'status' });
  assert.equal(f.$('login-input').hidden, true);
  response.resolve(f.response(pending)); await flush();
  assert.equal(f.$('login-input').hidden, false);
  assert.equal(f.$('login-code-input').value, '');
  assert.equal(f.$('login-submit').disabled, false);
  f.$('login-code-input').value = 'NEW_CALLBACK';
  await f.click('login-submit', { provider: 'pi', phase: 'authorization_completed' });
  assert.match(f.$('login-message').textContent, /登入流程已完成/);
  assert.equal(f.calls.filter(call => call.json?.step === 'start').length, 1);
});

test('authorization return after expiry or explicit close does not restart or restore the flow', async () => {
  for (const expire of [true, false]) {
    const f = fixture(); await f.ready();
    const pending = { provider: 'claude', phase: 'awaiting_authorization',
      authorizationUrl: 'https://claude.ai/oauth/authorize?state=TRANSIENT_ONLY' };
    await f.click('login', pending);
    if (!expire) await f.click('login-close');
    f.doc.hidden = true; f.doc.emit('visibilitychange');
    await f.clock.advance(expire ? 125000 : 1000);
    const count = f.calls.length;
    f.doc.hidden = false; f.doc.emit('visibilitychange');
    await f.clock.advance(0);
    assert.equal(f.calls.length, count);
    assert.equal(f.$('login-link').getAttribute('href'), null);
    assert.equal(f.$('login-panel').hidden, true);
  }
});

test('login start completing across a tab switch restores only by a fresh protected status', async () => {
  const f = fixture(); await f.ready();
  const slow = deferred(); f.responses.push(() => slow.promise);
  await f.click('login');
  f.doc.hidden = true; f.doc.emit('visibilitychange');
  f.doc.hidden = false; f.doc.emit('visibilitychange');
  slow.resolve(f.response({ provider: 'claude', phase: 'awaiting_authorization',
    authorizationUrl: 'https://claude.ai/oauth/authorize?state=STALE' })); await flush();
  assert.equal(f.$('login-link').getAttribute('href'), null);
  f.responses.push(f.response({ provider: 'claude', phase: 'authorization_completed' }));
  await f.clock.advance(5000);
  assert.deepEqual(f.calls.at(-1).json, { action: 'login', provider: 'claude', step: 'status' });
  assert.match(f.$('login-message').textContent, /登入流程已完成/);
});
