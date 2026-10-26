import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import express from 'express';
import {installBridgeBodyParser,registerPaseoBridge} from './adapter.mjs';
import {nativeHttpClient} from './native-onboarding.mjs';
import {nativeMcpConfig} from './native-mcp.mjs';
import {haIngressMiddleware,haIngressAllowed} from './ha-ingress.mjs';
import {assertSafePath,RuntimeError} from '../vendor/pi-paseo/src/state.mjs';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const absolute=(value)=>{if(typeof value!=='string'||!path.isAbsolute(value))throw new RuntimeError('INVALID_RUNTIME_PATH');assertSafePath(value);return path.resolve(value);};
const port=(value,fallback)=>{const result=Number(value??fallback);if(!Number.isInteger(result)||result<1024||result>65535)throw new RuntimeError('INVALID_PORT');return result;};

export function standaloneConfig(env=process.env){
 const haIngress=env.OPENDESIGN_PASEO_TRANSPORT==='ha-ingress';
 if(env.OPENDESIGN_PASEO_TRANSPORT&&!haIngress&&env.OPENDESIGN_PASEO_TRANSPORT!=='https')throw new RuntimeError('CONFIG_INVALID');
 let origin;
 if(!haIngress)try{const url=new URL(env.OPENDESIGN_PASEO_ORIGIN);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw 0;origin=url.origin;}catch{throw new RuntimeError('CONFIG_INVALID');}
 return {haIngress,socketPath:haIngress?absolute(env.OPENDESIGN_PASEO_SOCKET):undefined,dataDir:absolute(env.OPENDESIGN_PASEO_DATA_DIR),home:absolute(env.HOME),
  bundledPlugin:absolute(env.OPENDESIGN_PASEO_BUNDLED_PLUGIN),packageRoot:sourceRoot,
  nativePort:port(env.OPENDESIGN_PASEO_NATIVE_PORT,7457),listenPort:port(env.OPENDESIGN_PASEO_PORT,7460),
  origin,autoEnableOnStart:env.OPENDESIGN_PASEO_AUTO_ENABLE==='1',reconcileExistingOnboarding:true,env};
}

/** Only the immutable, packaged native launcher authorizes this deployment. */
export function verifyBundledInstallation(directory,packageRoot=sourceRoot){
 try{
  for(const name of ['open-design.json','SKILL.md']){
   const actual=path.join(directory,name);assertSafePath(actual);
   const expected=path.join(packageRoot,'launcher',name);
   const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
   if(hash(actual)!==hash(expected))return false;
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'open-design.json'),'utf8'));
  return manifest.name==='woow-paseo'&&manifest.od?.launch?.path==='/paseo/setup/';
 }catch{return false;}
}

export function createStandaloneApp(config,{manager,nativeRequest,mcpConfig}={}){
 const app=express();app.disable('x-powered-by');
 const request=nativeRequest||nativeHttpClient(config.nativePort);
 const verifyInstallation=()=>verifyBundledInstallation(config.bundledPlugin,config.packageRoot);
 if(!verifyInstallation())throw new RuntimeError('CONFIG_PLUGIN_NOT_INSTALLED');
 if(config.haIngress)app.use(haIngressMiddleware);
 const authorization={allowedOrigins:[config.origin],...(config.haIngress?{authorizeRequest:haIngressAllowed}:{})};
 installBridgeBodyParser(app,authorization);
 const bridge=registerPaseoBridge(app,{...config,port:config.nativePort,
  ...authorization,nativeRequest:request,verifyInstallation,manager,mcpConfig:mcpConfig||nativeMcpConfig(request)});
 app.get('/healthz',(_req,res)=>{const ok=verifyInstallation();return res.status(ok?200:503).json({ok,service:'opendesign-paseo'});});
 app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND'}}));
 app.use((_err,_req,res,_next)=>res.status(500).json({error:{code:'OPERATION_FAILED'}}));
 return {app,bridge};
}
