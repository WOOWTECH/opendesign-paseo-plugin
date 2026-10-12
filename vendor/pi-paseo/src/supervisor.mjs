import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DefaultPackageManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import * as runtime from './runtime.mjs';
import {processIdentity, assertSafePath} from './state.mjs';
import { readRecord, writeRecord, withLock, ensureOnboarding, createViaLocalWeb } from './onboarding.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function alive(pid) {try{process.kill(pid,0);return true;}catch{return false;}}
function sameProcess(record) {
 if (!Number.isInteger(record.pid)||record.pid<=1||typeof record.packageRoot!=='string'||!path.isAbsolute(record.packageRoot)||!alive(record.pid)||!record.identity||processIdentity(record.pid)!==record.identity) return false;
 try {
  const args=fs.readFileSync('/proc/'+record.pid+'/cmdline','utf8').split('\0');
  return args.includes(path.join(record.packageRoot,'bin/cli.mjs'))&&args.includes('supervise');
 } catch{return process.platform!=='linux'&&record.packageRoot===root;}
}
async function stopOwnedSupervisor(record,timeoutMs) {
 if(!sameProcess(record))return;
 try {process.kill(record.pid,'SIGTERM');} catch(error) {if(error.code!=='ESRCH')throw error;}
 const deadline=Date.now()+timeoutMs;
 while(sameProcess(record)) {
  if(Date.now()>=deadline)throw new Error('Plugin supervisor is still stopping');
  await delay(Math.min(100,Math.max(1,deadline-Date.now())));
 }
}
function sameRoot(installedPath) {
 if(typeof installedPath!=='string')return false;
 try{return fs.realpathSync(installedPath)===fs.realpathSync(root);}catch{return false;}
}
export function packageEnabled(loc=runtime.locations(),{cwd}={}) {
 const registration=readRecord(path.join(loc.stateDir,'host-registration.json'));
 // Service stop is independent of whether Pi still has the package enabled.
 if(registration.enabled===false)return false;
 cwd=cwd||registration.cwd||process.cwd();
 const settings=SettingsManager.create(cwd,loc.agentDir);
 const manager=new DefaultPackageManager({cwd,agentDir:loc.agentDir,settingsManager:settings});
 const scopes={user:settings.getGlobalSettings(),project:settings.getProjectSettings()};
 return manager.listConfiguredPackages().some(pkg=>{
  if(!sameRoot(pkg.installedPath))return false;
  const entry=(scopes[pkg.scope].packages||[]).find(p=>(typeof p==='string'?p:p.source)===pkg.source);
  return typeof entry==='string'||!!entry&&(!Array.isArray(entry.extensions)||entry.extensions.length>0);
 });
}
/** @param {{fallbackOnboarding?: boolean, cwd?: string}} [options] */
export async function startSupervisor({fallbackOnboarding=false,cwd}={}) {
 const loc=runtime.locations(),file=path.join(loc.stateDir,'supervisor.json');
 return withLock(path.join(loc.stateDir,'supervisor-start.lock'),async()=>{
  if(!packageEnabled(loc,{cwd}))return {running:false};
  const old=readRecord(file);
  if(sameProcess(old)) {
   if(old.packageRoot===root)return {running:true,pid:old.pid};
   await stopOwnedSupervisor(old,5000);
  }
  const logFile=path.join(loc.stateDir,'supervisor.log');
  assertSafePath(logFile);
  const log=fs.openSync(logFile,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
  let child;
  try {
   fs.fchmodSync(log,0o600);
   child=spawn(process.execPath,[path.join(root,'bin/cli.mjs'),'supervise',...(fallbackOnboarding?['--fallback-onboarding']:[])],{cwd:cwd||readRecord(path.join(loc.stateDir,'host-registration.json')).cwd||process.cwd(),detached:true,stdio:['ignore',log,log],env:process.env});
  } finally {fs.closeSync(log);}
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  writeRecord(file,{pid:child.pid,identity:processIdentity(child.pid),packageRoot:root,startedAt:new Date().toISOString()});child.unref();
  return {running:true,pid:child.pid};
 });
}
export async function stopSupervisor({timeoutMs=5000}={}) {
 const loc=runtime.locations();
 return withLock(path.join(loc.stateDir,'supervisor-start.lock'),async()=>{
  await stopOwnedSupervisor(readRecord(path.join(loc.stateDir,'supervisor.json')),timeoutMs);
  return {stopped:true};
 });
}
export async function supervise({fallbackOnboarding=false}={}) {
 const loc=runtime.locations();
 let stop=false,initialized=false,retries=0,wake;
 const shutdown=()=>{stop=true;wake?.();};
 const wait=ms=>new Promise(resolve=>{
  if(stop){resolve();return;}
  const timer=setTimeout(done,ms);
  function done(){clearTimeout(timer);wake=undefined;resolve();}
  wake=done;
 });
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 try {
  while(!stop) {
   if(!packageEnabled(loc)){await runtime.deactivate();break;}
   try {
    const result=await runtime.status();
    if(stop)break;
    if(!packageEnabled(loc)){await runtime.deactivate();break;}
    if(!initialized||!result.daemon?.running) {await runtime.activate();initialized=true;}
    if(stop)break;
    if(!packageEnabled(loc)){await runtime.deactivate();break;}
    if(fallbackOnboarding) {
     const api=await import('./onboarding.mjs');
     if(!stop&&!api.onboardingStatus(loc).sessionId) await ensureOnboarding((p,remember)=>createViaLocalWeb(p,loc,remember),loc);
    }
    retries=0;
   } catch(e) {
    // Keep only an error class; providers and pairing output can carry credentials.
    writeRecord(path.join(loc.stateDir,'supervisor-error.json'),{kind:e?.name||'Error',at:new Date().toISOString(),retry:++retries});
   }
   await wait(Math.min(15000*Math.max(retries,1),60000));
  }
 } finally {
  process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);
  // If the host's bounded wait expires, finish stopping after any in-flight work.
  if(stop)await runtime.deactivate();
 }
}
