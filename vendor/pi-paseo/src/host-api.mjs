import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as runtime from './runtime.mjs';
import { ensureOnboarding, onboardingStatus, readRecord, writeRecord, withLock } from './onboarding.mjs';
import { startSupervisor, stopSupervisor, packageEnabled } from './supervisor.mjs';

const enabledBinding = p => p.disabled !== true && p.status !== 'disabled' && p.status !== 'missing';
export async function status() {
  const result=await runtime.status();
  const onboarding=onboardingStatus();
  return {...result,onboardingSessionId:onboarding.sessionId||null,onboardingCompleted:!!onboarding.completed,
    openUrl:'https://app.paseo.sh',setupUrl:'/paseo/setup',settings:readRecord(path.join(runtime.locations().stateDir,'preferences.json'))};
}
export async function lifecycle(input={}, hooks={}) {
  const loc=runtime.locations();
  return withLock(path.join(loc.stateDir,'host-lifecycle.lock'),async()=>{
    const file=path.join(loc.stateDir,'host-registration.json'),previous=readRecord(file);
    const explicitStop=['disable','stop','remove'].includes(input.action);
    const explicitEnable=['enable','activate'].includes(input.action);
    const active=!explicitStop&&(explicitEnable||previous.enabled!==false)&&
      (Array.isArray(input.packages)?input.packages.some(enabledBinding):input.action==='restore'?packageEnabled(loc):true);
    writeRecord(file,{enabled:active,packageRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cwd:input.cwd||previous.cwd||loc.home,registeredAt:new Date().toISOString()});
    if (!active) {
      // A supervisor may still be finishing activate(). Deactivate only after it exits.
      await stopSupervisor();
      await runtime.deactivate();
      return {phase:'disabled',onboardingSessionId:onboardingStatus().sessionId||null};
    }
    // npm may run before Pi writes the binding; the persisted pause still wins.
    if(input.prepareRuntime===true)await runtime.activate();
    const supervisor=await startSupervisor({fallbackOnboarding:!hooks.createOnboarding});
    if(!supervisor.running)return {phase:'disabled',onboardingSessionId:onboardingStatus().sessionId||null};
    let onboarding=onboardingStatus();
    if (hooks.createOnboarding) onboarding=await ensureOnboarding(hooks.createOnboarding);
    return {phase:'starting',scheduled:true,onboardingSessionId:onboarding.sessionId||null};
  },{timeoutMs:input.prepareRuntime===true?360000:15000});
}
export async function restore(hooks={}) { return lifecycle({action:'restore'},hooks); }
export async function listModels(provider) { return runtime.listModels(provider); }
export async function diagnostics() { return runtime.diagnose(); }
export async function pair() {
  const result=await runtime.pair();
  return {url:result.url, ...(result.expiresAt?{expiresAt:result.expiresAt}:{})};
}
export async function saveConfig(input) {
  if (!input||typeof input!=='object'||Array.isArray(input)) throw new Error('Invalid settings');
  if (Object.keys(input).some(k=>!['name'].includes(k))) throw new Error('Unsupported setting');
  const name=typeof input.name==='string'?input.name.trim():'';
  if (name.length>100||/[\x00-\x1f]/.test(name)) throw new Error('Invalid name');
  writeRecord(path.join(runtime.locations().stateDir,'preferences.json'),{name:name||'Pi Agent',connection:'relay'});
  const snapshot=await runtime.status();
  if(snapshot.installed&&snapshot.enabled&&snapshot.daemon.running&&!snapshot.diagnosticCode)await runtime.activate();
  return {saved:true};
}
export async function completeOnboarding() {
  const loc=runtime.locations(),file=path.join(loc.stateDir,'onboarding.json'),record=readRecord(file);
  writeRecord(file,{...record,completed:true,completedAt:new Date().toISOString()});
  return {completed:true};
}
