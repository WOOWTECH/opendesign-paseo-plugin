import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONNECTION_TARGETS, targetConfiguration, validatePairingOffer } from '../vendor/pi-paseo/src/connection-targets.mjs';
import { createManager } from '../src/manager.mjs';
import { sourceRoot } from '../src/runtime-context.mjs';
import { managedConfiguration } from '../vendor/pi-paseo/src/runtime.mjs';
import { legacyRuntimeDirectory, legacyRuntimeReady, LEGACY_RUNTIME_REVISION, LEGACY_PASEO_VERSION } from '../vendor/pi-paseo/src/runtime-layout.mjs';

function offer(profile, minimumSecurityMode) {
  const body={v:2,serverId:'server_fixture',daemonPublicKeyB64:'cHVibGljLWtleQ',relay:{endpoint:profile.relayEndpoint,useTls:true}};
  if(minimumSecurityMode!==undefined)body.minimumSecurityMode=minimumSecurityMode;
  return `${profile.appUrl}/#offer=${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
}

test('profiles atomically configure app, relay, CORS and protected security',()=>{
  let config={daemon:{relay:{requireProtectedSecurity:true},cors:{allowedOrigins:['https://tenant.example','https://smart.apporo.ai']}}};
  config=targetConfiguration(config,'apporo');
  assert.equal(config.app.baseUrl,'https://smart.apporo.ai');
  assert.deepEqual(config.daemon.relay,{requireProtectedSecurity:false,enabled:true,endpoint:'relay.apporo.ai:443',publicEndpoint:'relay.apporo.ai:443',useTls:true,publicUseTls:true});
  assert.deepEqual(config.daemon.cors.allowedOrigins,['https://tenant.example','https://smart.apporo.ai']);
  config=targetConfiguration(config,'paseo');
  assert.equal(config.daemon.relay.requireProtectedSecurity,true,'official security is restored after a branded target');
  assert.deepEqual(config.daemon.cors.allowedOrigins,['https://tenant.example','https://app.paseo.sh']);
});

test('managed config preserves identity, daemon keys and extra listeners while converting legacy fields',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'od-config-')),stateDir=path.join(root,'state');fs.mkdirSync(stateDir);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(stateDir,'preferences.json'),JSON.stringify({name:'OpenDesign',connectionTarget:'paseo'}));
  const loc={home:root,agentDir:path.join(root,'pi'),stateDir};
  const launchers={claude:{startup:'missing'},codex:{startup:'missing'},pi:{startup:'missing'}};
  const original={app:{other:'kept'},daemon:{name:'legacy-invalid',listen:'127.0.0.1:6767,100.64.0.1:6767',identity:{serverId:'server_fixture',privateKey:'private_fixture'},relay:{other:'kept'},cors:{allowedOrigins:['https://tenant.example']}},agents:{providers:{custom:{enabled:true}}}};
  const {config}=managedConfiguration(original,7000,launchers,loc,{PI_AGENT_DATA_DIR:loc.agentDir});
  assert.equal(config.daemon.name,undefined);
  assert.equal(config.daemon.listen,'127.0.0.1:7000,100.64.0.1:6767');
  assert.deepEqual(config.daemon.identity,original.daemon.identity);
  assert.equal(config.daemon.relay.other,'kept');assert.equal(config.app.other,'kept');
  assert.equal(config.agents.providers.custom.enabled,true);
});

test('a fresh target selection configures a first start without requiring a display name',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'od-fresh-target-')),stateDir=path.join(root,'state');fs.mkdirSync(stateDir);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(stateDir,'preferences.json'),JSON.stringify({connectionTarget:'apporo',target:'apporo'}));
  const loc={home:root,agentDir:path.join(root,'pi'),stateDir};
  const launchers={claude:{startup:'missing'},codex:{startup:'missing'},pi:{startup:'missing'}};
  const {config}=managedConfiguration({},7001,launchers,loc,{PI_AGENT_DATA_DIR:loc.agentDir});
  assert.equal(config.app.baseUrl,'https://smart.apporo.ai');
  assert.equal(config.daemon.relay.endpoint,'relay.apporo.ai:443');
  assert.equal(config.daemon.relay.requireProtectedSecurity,false);
});

test('pairing validation binds origin, decoded relay and security to the target',()=>{
  for(const profile of CONNECTION_TARGETS){
    const security=profile.protectedRelay?'protected':undefined;
    assert.equal(validatePairingOffer(offer(profile,security),profile.id),offer(profile,security));
  }
  assert.throws(()=>validatePairingOffer(offer(CONNECTION_TARGETS[0],'protected'),'woowtech'),{code:'PAIRING_ORIGIN_INVALID'});
  const wrong=offer({...CONNECTION_TARGETS[1],relayEndpoint:'relay.paseo.sh:443'});
  assert.throws(()=>validatePairingOffer(wrong,'woowtech'),{code:'PAIRING_TARGET_MISMATCH'});
  assert.throws(()=>validatePairingOffer(offer(CONNECTION_TARGETS[1],'protected'),'woowtech'),{code:'PAIRING_SECURITY_UNSUPPORTED'});
  assert.throws(()=>validatePairingOffer(offer(CONNECTION_TARGETS[0]),'paseo'),{code:'PAIRING_SECURITY_UNSUPPORTED'});
});

test('manager saves target intent without stopping, blocks pairing, and applies only after explicit disable-enable',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'od-target-')),home=path.join(root,'home'),dataDir=path.join(root,'data');fs.mkdirSync(home);fs.mkdirSync(dataDir);
  let running=false,desired='paseo',active=null;const calls=[];
  const runtime=async(_context,action,input)=>{
    calls.push(action);
    if(action==='target'){desired=input.target;return state();}
    if(action==='enable'){running=true;active=desired;return state();}
    if(action==='disable'){running=false;active=null;return state();}
    if(action==='pair')return{url:offer(CONNECTION_TARGETS.find(row=>row.id===active),active==='paseo'?'protected':undefined),target:active};
    return state();
  };
  const state=()=>({installed:true,version:'0.17.5',phase:running&&active!==desired?'restart_required':running?'running':'disabled',daemon:{owned:true,running,reachable:running},providers:[],connectionTarget:desired,activeTarget:running?active:null,targetPending:running&&active!==desired,restartRequired:running&&active!==desired});
  const manager=createManager({home,dataDir,packageRoot:sourceRoot,env:{PATH:process.env.PATH}},{runtime,supervisor:{start:async()=>calls.push('supervisor-start'),stop:async()=>calls.push('supervisor-stop')}});
  t.after(async()=>{await manager.shutdown();fs.rmSync(root,{recursive:true,force:true});});
  await manager.enable();const before=calls.length;
  const pending=await manager.configureTarget('woowtech');
  assert.equal(pending.schemaVersion,1,'the target response is the same public DTO as a normal refresh');
  assert.equal(pending.desiredEnabled,true,'saving a target preserves service enable intent');
  assert.equal(pending.connectionTarget,'woowtech');assert.equal(pending.targetPending,true);assert.equal(calls.slice(before).includes('disable'),false);
  await assert.rejects(manager.pair('woowtech'),{code:'RESTART_REQUIRED'});
  await manager.disable();await manager.enable();
  const applied=await manager.status();assert.equal(applied.activeTarget,'woowtech');assert.equal(applied.targetPending,false);
  assert.equal((await manager.pair('woowtech')).target,'woowtech');
});

test('the exact owned 0.11.2 release is recognized only from its immutable receipt and package versions',t=>{
  const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),'od-legacy-')),loc={runtimeDir},root=legacyRuntimeDirectory(loc);
  t.after(()=>fs.rmSync(runtimeDir,{recursive:true,force:true}));
  for(const pkg of ['cli','server']){const dir=path.join(root,'node_modules/@getpaseo',pkg);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:`@getpaseo/${pkg}`,version:LEGACY_PASEO_VERSION}));}
  fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify({revision:LEGACY_RUNTIME_REVISION,lockSha256:'ae1416f8ca854dac432e1eac0e057490bce581ab08c0d60851f3298bb8893d00'}));
  assert.equal(legacyRuntimeReady(loc),true);
  fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify({revision:LEGACY_RUNTIME_REVISION,lockSha256:'0'.repeat(64)}));
  assert.equal(legacyRuntimeReady(loc),false);
});
