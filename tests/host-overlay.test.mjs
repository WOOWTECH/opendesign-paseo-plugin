import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import vm from 'node:vm';
import {replaceOnce,patchServer,patchMcpConfig,patchHtml,applyOverlay,digest} from '../host/overlay.mjs';
test('unknown and duplicate host anchors fail closed',()=>{
 assert.throws(()=>replaceOnce('absent','anchor','new'),{code:'HOST_NOT_COMPATIBLE'});assert.throws(()=>replaceOnce('anchor anchor','anchor','new'),{code:'HOST_NOT_COMPATIBLE'});assert.equal(replaceOnce('before anchor after','anchor','new'),'before new after');
});
test('host source patches retain native auth/parser ordering and lifecycle hooks',()=>{
 const source="    app.use(express.json({ limit: '4mb' }));\n    if (fs.existsSync(staticDir)) {\n                daemonUrl = url;\n        const cleanupDaemonBackgroundWork = () => {\n            daemonShutdownStarted = true;";
 const result=patchServer(source,'/safe/release');assert.ok(result.indexOf('installBridgeBodyParser(app')<result.indexOf('app.use(express.json'));assert.ok(result.includes('woowPaseoBridge.start()'));assert.ok(result.includes('woowPaseoBridge.disarm()'));assert.ok(result.includes('await woowPaseoBridge.shutdown()'));assert.ok(result.includes('file:///safe/release/host/adapter.mjs'));
});
test('actual patched startup separates safe recovery errors from registration errors and blocks asset HTML fallthrough',async()=>{
 const source="    app.use(express.json({ limit: '4mb' }));\n    if (fs.existsSync(staticDir)) {\n                daemonUrl = url;\n        const cleanupDaemonBackgroundWork = () => {\n            daemonShutdownStarted = true;";
 const patched=patchServer(source,'/safe/release'),start=patched.indexOf('    let woowPaseoBridge ='),end=patched.indexOf('    if (fs.existsSync(staticDir)) {',start);
 const body=patched.slice(start,end).replace("await import('./mcp-config.js')",'mcpConfig');
 for(const phase of ['recovery','registration','unknown-recovery']){
  const routes=new Map(),logs=[];let checked=false;
  const secret='private-fixture-error-must-not-escape';
  const error=Object.assign(new Error(secret),{code:phase==='unknown-recovery'?secret:'PLUGIN_TRANSACTION_INVALID_JOURNAL'});
  const run=vm.runInNewContext(`(async()=>{${body};return woowPaseoBridge;})`,{
   app:{get:(route,handler)=>routes.set('GET '+route,handler),post:(route,handler)=>routes.set('POST '+route,handler)},
   console:{warn:value=>logs.push(value)},db:{},PLUGIN_REGISTRY_ROOTS:{},PLUGIN_LOCKFILE_PATH:'/data/od-plugin-lock.json',RUNTIME_DATA_DIR:'/data',process:{env:{HOME:'/home'}},resolvedPort:7457,port:7457,mcpConfig:{},configuredAllowedOrigins:()=>[],getInstalledPlugin:()=>null,
   recoverManagedPaseoPlugin:async()=>{if(phase!=='registration')throw error;},registerPaseoBridge:()=>{checked=true;throw error;}
  });
  const bridge=await run();assert.equal(typeof bridge.start,'function');assert.equal(checked,phase==='registration');
  const code=phase==='registration'?'PASEO_BRIDGE_REGISTRATION_FAILED':phase==='unknown-recovery'?'PLUGIN_TRANSACTION_RECOVERY_FAILED':'PLUGIN_TRANSACTION_INVALID_JOURNAL';
  for(const route of ['/api/paseo-bridge','/paseo/setup','/paseo/entry.js','/paseo/assets/setup.js','/paseo/assets/setup.css']){
   let status,value;const headers={};routes.get('GET '+route)({}, {setHeader:(name,val)=>headers[name]=val,status:n=>{status=n;return{json:x=>{value=x;}};}});
   assert.equal(status,503);assert.equal(value.error.code,code);assert.equal(value.error.phase,phase==='registration'?'registration':'recovery');assert.equal(headers['Cache-Control'],'private, no-store');
  }
  assert.equal(logs.length,1);assert.ok(logs[0].includes(code));assert.equal(logs[0].includes(secret),false);assert.ok(routes.has('POST /api/paseo-bridge'));
 }
});
test('native MCP mutation transform runs inside native queue and writes a private new file',()=>{
 const out=patchMcpConfig("    const next = sanitizeMcpConfig(body);\n    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');");assert.ok(out.includes('await body(await readMcpConfig(dataDir))'));assert.ok(out.includes("mode: 0o600, flag: 'wx'"));assert.throws(()=>patchHtml('no html'),{code:'HOST_NOT_COMPATIBLE'});
});
test('failed multi-file activation rolls back only owned completed changes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'od-overlay-'));try{
  const entries=[];for(const relative of ['first.js','second.js']){const originalFile=path.join(dir,relative+'.original'),patchedFile=path.join(dir,relative+'.patched');fs.writeFileSync(path.join(dir,relative),'original');fs.writeFileSync(originalFile,'original');fs.writeFileSync(patchedFile,'patched');entries.push({relative,before:digest('original'),after:digest('patched'),originalFile,patchedFile,mode:0o600});}
  fs.writeFileSync(path.join(dir,'second.js'),'foreign edit');assert.throws(()=>applyOverlay({hostRoot:dir,entries}),{code:'HOST_EXTERNAL_CHANGE'});assert.equal(fs.readFileSync(path.join(dir,'first.js'),'utf8'),'original');assert.equal(fs.readFileSync(path.join(dir,'second.js'),'utf8'),'foreign edit');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('symlink and hardlink destinations cannot redirect activation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'od-overlay-link-'));try{
  const originalFile=path.join(dir,'original'),patchedFile=path.join(dir,'patched');fs.writeFileSync(originalFile,'original');fs.writeFileSync(patchedFile,'patched');fs.symlinkSync(originalFile,path.join(dir,'target'));
  const entry={relative:'target',before:digest('original'),after:digest('patched'),originalFile,patchedFile,mode:0o600};assert.throws(()=>applyOverlay({hostRoot:dir,entries:[entry]}),{code:'UNSAFE_SYMLINK'});assert.equal(fs.readFileSync(originalFile,'utf8'),'original');fs.unlinkSync(path.join(dir,'target'));fs.linkSync(originalFile,path.join(dir,'target'));assert.throws(()=>applyOverlay({hostRoot:dir,entries:[entry]}),{code:'HOST_EXTERNAL_CHANGE'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
