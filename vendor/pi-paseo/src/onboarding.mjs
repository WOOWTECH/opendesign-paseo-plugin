import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { locations, atomicJson, privateDirectory, assertSafePath, processIdentity, RuntimeError, withLockTransition, checkLockSignal, pauseForLock } from './state.mjs';

export function readRecord(file, fallback = {}) {
  try {
    assertSafePath(file);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
    return record;
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    if (e.code === 'UNSAFE_SYMLINK') throw e;
    throw new Error('Invalid plugin state file');
  }
}
export function writeRecord(file, record) { atomicJson(file, record); }
function sameDirectory(a, b) { return a?.ino === b?.ino && a?.dev === b?.dev && a?.mtimeMs === b?.mtimeMs; }
function liveOwner(owner) {
  if (!Number.isInteger(owner.pid) || owner.pid <= 1) return false;
  const identity = processIdentity(owner.pid);
  if (owner.identity && identity) return owner.identity === identity;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function withLock(file, fn, { timeoutMs = 15000, signal, helper } = {}) {
  checkLockSignal(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeError('INVALID_LOCK_OPTIONS');
  privateDirectory(path.dirname(file));
  const until = Date.now() + timeoutMs, token = crypto.randomUUID();
  let acquired;
  while (true) {
    checkLockSignal(signal);
    if (Date.now() >= until) throw new RuntimeError('LOCK_BUSY', 'Plugin operation is already running');
    acquired = withLockTransition(file, () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        assertSafePath(file);
        try {
          fs.mkdirSync(file, { mode: 0o700 });
          const stat = fs.lstatSync(file);
          try { writeRecord(path.join(file, 'owner.json'), { pid: process.pid, identity: processIdentity(process.pid), token }); }
          catch (error) { fs.rmSync(file, { recursive: true, force: true }); throw error; }
          return stat;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          try {
            const before = assertSafePath(file);
            if (!before) continue;
            if (!before.isDirectory()) throw new RuntimeError('UNSAFE_LOCK');
            let owner;
            try { owner = readRecord(path.join(file, 'owner.json')); }
            catch (error) { if (error.code === 'UNSAFE_SYMLINK') throw error; }
            const old = Date.now() - before.mtimeMs > 30000;
            // Identity-bearing dead owners can be reclaimed immediately. Older
            // incomplete acquisitions still need the existing grace period.
            if (!liveOwner(owner || {}) && (owner?.identity || old)) {
              const again = assertSafePath(file);
              if (sameDirectory(before, again)) fs.rmSync(file, { recursive: true, force: true });
              continue;
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; else continue; }
          return null;
        }
      }
      return null;
    }, { timeoutMs: until - Date.now(), deadline:until, signal, helper });
    if (acquired) break;
    if (Date.now() >= until) throw new RuntimeError('LOCK_BUSY', 'Plugin operation is already running');
    await pauseForLock(Math.min(100, Math.max(1, until - Date.now())), signal);
  }
  try {
    return await fn();
  } finally {
    try {
      const current = assertSafePath(file);
      if (current?.ino === acquired.ino && current?.dev === acquired.dev && readRecord(path.join(file, 'owner.json')).token === token) fs.rmSync(file, { recursive: true, force: true });
    } catch {}
  }
}
export function onboardingStatus(loc = locations()) {
  return readRecord(path.join(loc.stateDir,'onboarding.json'));
}
export const onboardingPrompt = '這是使用者已授權的 Paseo 連線初始化對話。插件會在目前容器安裝並管理 Paseo，沿用 Claude Code、Codex、Pi 現有登入。' +
 '請用繁體中文呼叫 paseo_status，說明安裝、模型與登入狀態；引導使用者由插件設定頁完成官方 relay 配對。' +
 '官方 relay 通常不需要 Paseo 帳號密碼。密碼、API Key、配對連結只輸入受保護的設定畫面，不能貼到聊天或工具。' +
 '未完成設定時續用本對話，不建立重複對話，不自行更改權限、重裝全域工具、重啟 Pi Web 或操作其他服務。';
export async function ensureOnboarding(create, loc = locations()) {
  return withLock(path.join(loc.stateDir,'onboarding.lock'), async()=>{
    const file=path.join(loc.stateDir,'onboarding.json');
    let record=readRecord(file);
    if (record.sessionId) return record;
    if (record.creation === 'pending') throw new Error('Onboarding creation needs reconciliation; automatic duplicate creation is stopped');
    record={...record,creation:'pending',requestedAt:new Date().toISOString()};
    writeRecord(file,record);
    // Creators can checkpoint the ID as soon as it is known, before naming,
    // prompting or shutdown. Those later operations must never hide creation.
    const remember = sessionId => {
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('Host did not return an onboarding session id');
      if (record.sessionId && record.sessionId !== sessionId) throw new Error('Onboarding session id changed');
      record = { ...record, sessionId, creation: 'created', completed: false };
      writeRecord(file, record);
    };
    try {
      const created = await create(onboardingPrompt, remember);
      const sessionId = typeof created === 'string' ? created : created?.sessionId;
      remember(sessionId);
      return record;
    } catch (e) {
      // Only a proven pre-creation failure permits retry. Unknown host results
      // stay pending; a confirmed ID always resumes the same conversation.
      record = { ...record, ...(e instanceof CreationNotStarted && !record.sessionId ? { creation: 'retryable' } : {}), error: 'Host could not confirm onboarding initialization' };
      writeRecord(file, record);
      throw e;
    }
  });
}
export async function localWebApi(route, body, {method='POST', cookie, port=process.env.PI_WEB_PORT||process.env.PORT||'30141'}={}) {
  if (!/^\d{1,5}$/.test(String(port))||Number(port)<1||Number(port)>65535) throw new Error('Invalid Pi Web port');
  const response=await fetch('http://127.0.0.1:'+port+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Pi Web request rejected (HTTP '+response.status+')');
  return response;
}
class CreationNotStarted extends Error {
  constructor() { super('Pi Web login is unavailable'); this.name = 'OnboardingLoginError'; }
}
export async function createViaLocalWeb(prompt, loc = locations(), remember = () => {}) {
  let cookie;
  try {
    if (process.env.PI_WEB_PASSWORD) {
      const login = await localWebApi('/api/web-auth', { password: process.env.PI_WEB_PASSWORD });
      cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
      if (!cookie) throw new Error();
    }
  } catch { throw new CreationNotStarted(); }
  const response = await localWebApi('/api/agent/new', { cwd: loc.home, type: 'ensure_session' }, { cookie });
  const created = await response.json();
  if (typeof created.sessionId !== 'string' || !created.sessionId) throw new Error('Pi Web returned no session');
  remember(created.sessionId);
  const route = '/api/agent/' + encodeURIComponent(created.sessionId);
  await localWebApi(route, { type: 'set_session_name', name: 'Paseo 連線初始化' }, { cookie });
  await localWebApi(route, { type: 'prompt', message: prompt }, { cookie });
  return created.sessionId;
}
