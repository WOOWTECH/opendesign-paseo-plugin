import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {replaceOnce,patchServer,patchMcpConfig,patchHtml,applyOverlay,digest} from '../host/overlay.mjs';
test('unknown and duplicate host anchors fail closed',()=>{
 assert.throws(()=>replaceOnce('absent','anchor','new'),{code:'HOST_NOT_COMPATIBLE'});assert.throws(()=>replaceOnce('anchor anchor','anchor','new'),{code:'HOST_NOT_COMPATIBLE'});assert.equal(replaceOnce('before anchor after','anchor','new'),'before new after');
});
test('host source patches retain native auth/parser ordering and lifecycle hooks',()=>{
 const source="    app.use(express.json({ limit: '4mb' }));\n    if (fs.existsSync(staticDir)) {\n                daemonUrl = url;\n        const cleanupDaemonBackgroundWork = () => {\n            daemonShutdownStarted = true;";
 const result=patchServer(source,'/safe/release');assert.ok(result.indexOf('installBridgeBodyParser(app')<result.indexOf('app.use(express.json'));assert.ok(result.includes('woowPaseoBridge.start()'));assert.ok(result.includes('woowPaseoBridge.disarm()'));assert.ok(result.includes('await woowPaseoBridge.shutdown()'));assert.ok(result.includes('file:///safe/release/host/adapter.mjs'));
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
