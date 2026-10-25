import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {standaloneConfig,verifyBundledInstallation,createStandaloneApp} from '../host/standalone.mjs';

const root=path.resolve(import.meta.dirname,'..');
const origin='https://od.example.test';
async function harness(t,{autoEnable=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'od-launcher-'));
 const bundledPlugin=path.join(dir,'woow-paseo');fs.mkdirSync(bundledPlugin);
 for(const name of ['open-design.json','SKILL.md'])fs.copyFileSync(path.join(root,'launcher',name),path.join(bundledPlugin,name));
 const calls=[];let desired=false;
 const manager={status:async()=>({phase:desired?'running':'disabled',desiredEnabled:desired}),
  enable:async()=>{desired=true;calls.push('enable');},disable:async()=>{desired=false;calls.push('disable');},
  restore:async()=>{calls.push('restore');},shutdown:async()=>{},cancelPending(){},cancelQueuedOperations(){},
  models:async provider=>({provider,models:[{id:'available'}]}),ensureOnboarding:async()=>({url:'/projects/p/conversations/c'})};
 const config={dataDir:dir,home:dir,packageRoot:root,bundledPlugin,nativePort:7457,origin,autoEnableOnStart:autoEnable};
 const {app,bridge}=createStandaloneApp(config,{manager,nativeRequest:async()=>({servers:[]})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await bridge.shutdown();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 return {config,bridge,calls,base,manager,dir,post:body=>fetch(base+'/api/paseo-bridge',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)})};
}

test('configuration requires explicit tenant paths and HTTPS origin',()=>{
 const good={HOME:'/home/example',OPENDESIGN_PASEO_DATA_DIR:'/data/example',OPENDESIGN_PASEO_BUNDLED_PLUGIN:'/app/plugins/woow-paseo',OPENDESIGN_PASEO_ORIGIN:origin};
 assert.equal(standaloneConfig(good).listenPort,7460);
 for(const change of [{HOME:'relative'},{OPENDESIGN_PASEO_DATA_DIR:undefined},{OPENDESIGN_PASEO_ORIGIN:'http://example.test'},{OPENDESIGN_PASEO_ORIGIN:origin+'/wrong'},{OPENDESIGN_PASEO_PORT:'80'}])assert.throws(()=>standaloneConfig({...good,...change}));
});
test('native launch URL serves actual setup with private headers and safe assets',async t=>{
 const h=await harness(t);
 for(const route of ['/paseo/setup','/paseo/setup/']){
  const r=await fetch(h.base+route);assert.equal(r.status,200);assert.match(await r.text(),/Paseo 安裝與連線設定/);assert.match(r.headers.get('cache-control'),/no-store/);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 }
 assert.equal((await fetch(h.base+'/paseo/assets/setup.js')).status,200);
 assert.equal((await fetch(h.base+'/paseo/assets/%2e%2e%2fpackage.json')).status,404);
 assert.equal((await (await fetch(h.base+'/api/paseo-bridge')).json()).pluginInstalled,true);
});
test('modified or symlinked launcher cannot authorize a service',async t=>{
 const h=await harness(t);const manifest=path.join(h.config.bundledPlugin,'open-design.json');
 fs.appendFileSync(manifest,' ');assert.equal(verifyBundledInstallation(h.config.bundledPlugin),false);
 assert.throws(()=>createStandaloneApp(h.config),{code:'CONFIG_PLUGIN_NOT_INSTALLED'});
 fs.unlinkSync(manifest);fs.symlinkSync(path.join(root,'launcher/open-design.json'),manifest);
 assert.equal(verifyBundledInstallation(h.config.bundledPlugin),false);
});
test('cross-site, malformed and oversized mutations fail before manager calls',async t=>{
 const h=await harness(t);
 for(const [headers,body,status] of [[{Origin:'https://evil.test'},'{}',403],[{'Sec-Fetch-Site':'cross-site'},'{}',403],[{},'{',400],[{},'x'.repeat(17000),413]]){
  const r=await fetch(h.base+'/api/paseo-bridge',{method:'POST',headers:{'Content-Type':'application/json',...headers},body});assert.equal(r.status,status);
 }
 assert.deepEqual(h.calls,[]);
});
test('first boot enables once; explicit stop survives bridge restart',async t=>{
 const h=await harness(t);await h.bridge.start();assert.equal(h.calls.filter(x=>x==='enable').length,1);
 assert.equal((await h.post({action:'disable'})).status,202);
 for(let n=0;n<100&&!h.calls.includes('disable');n++)await new Promise(r=>setTimeout(r,5));
 assert.equal((await h.manager.status()).desiredEnabled,false);await h.bridge.shutdown();
 const second=createStandaloneApp(h.config,{manager:h.manager,nativeRequest:async()=>({servers:[]})});
 t.after(()=>second.bridge.shutdown());await second.bridge.start();
 assert.equal(h.calls.filter(x=>x==='enable').length,1);assert.ok(h.calls.includes('restore'));
});
