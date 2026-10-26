#!/usr/bin/env node
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {standaloneConfig,createStandaloneApp} from '../host/standalone.mjs';
import {nativeHttpClient} from '../host/native-onboarding.mjs';

// The deployment proxy owns authentication. This service is loopback-only and
// is never exposed by the Kubernetes Service or ingress directly.
const config=standaloneConfig();
const request=nativeHttpClient(config.nativePort);
const {app,bridge}=createStandaloneApp(config,{nativeRequest:request});
if(config.haIngress){
 try{
  const previous=fs.lstatSync(config.socketPath);
  if(!previous.isSocket()||previous.uid!==process.getuid())throw new Error('UNSAFE_SOCKET');
  fs.unlinkSync(config.socketPath);
 }catch(error){if(error.code!=='ENOENT')throw error;}
}
const server=config.haIngress?app.listen(config.socketPath,()=>fs.chmodSync(config.socketPath,0o660)):app.listen(config.listenPort,'127.0.0.1');
const abort=new AbortController();let closing;
function shutdown(){
 if(closing)return closing;
 abort.abort();server.closeAllConnections();
 closing=Promise.allSettled([bridge.shutdown(),new Promise(resolve=>server.close(resolve))]);
 return closing;
}
process.once('SIGTERM',()=>{void shutdown();});
process.once('SIGINT',()=>{void shutdown();});
server.on('error',()=>{process.exitCode=1;void shutdown();});
try{
 // Native project and MCP APIs must be bound before first-boot reconciliation.
 for(let attempt=0;;attempt++){
  if(abort.signal.aborted)break;
  try{const health=await request('GET','/api/health');if(health?.ok)break;}catch{}
  if(attempt>=59)throw new Error('NATIVE_UNAVAILABLE');
  await delay(1000,undefined,{signal:abort.signal});
 }
 if(!abort.signal.aborted)await bridge.start();
}catch{
 if(!abort.signal.aborted){process.stderr.write('Paseo launcher initialization failed\n');process.exitCode=1;}
 await shutdown();
}
