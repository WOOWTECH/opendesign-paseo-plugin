import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {atomicJson,assertSafePath,RuntimeError} from '../vendor/pi-paseo/src/state.mjs';
import {createManager} from '../src/manager.mjs';
import {nativeHttpClient,nativeOnboarding} from './native-onboarding.mjs';
import {BridgeError,requestAllowed,readBody,validateAction,safePairUrl,publicError,setPrivateHeaders} from './security.mjs';

export const PLUGIN_ID='woowtech-paseo';
export const MCP_ID='woow-paseo';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let activeBridge;
function read(file){assertSafePath(file);try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw new RuntimeError('STATE_CORRUPT');}}
function json(res,value,status=200){setPrivateHeaders(res);return res.status(status).json(value);}
function pluginVerified(record,root){
 if(!record||record.id!==PLUGIN_ID||record.sourceKind==='bundled')return false;
 try{
  for(const name of ['open-design.json','SKILL.md']){
   const original=path.join(sourceRoot,'plugin',name),file=path.join(root,PLUGIN_ID,name);assertSafePath(file);
   const digest=x=>createHash('sha256').update(fs.readFileSync(x)).digest('hex');
   if(digest(file)!==digest(original))return false;
  }
  return true;
 }catch{return false;}
}
/** Before the host's general JSON parser; malformed request bytes never enter an exception response. */
export function installBridgeBodyParser(app,{allowedOrigins=[]}={}){
 app.use('/api/paseo-bridge',(req,res,next)=>{
  setPrivateHeaders(res);
  if(!requestAllowed(req,allowedOrigins))return json(res,publicError(new BridgeError('UNTRUSTED_REQUEST',403)),403);
  if(req.method!=='POST')return next();
  void readBody(req).then(body=>{req.body=body;next();},error=>{req.resume?.();json(res,publicError(error),error.status||400);});
 });
}
export function registerPaseoBridge(app,options){
 const {dataDir,home,port,allowedOrigins=[],getInstalledPluginRecord}=options;
 const packageRoot=options.packageRoot||sourceRoot;
 const uiRoot=path.join(packageRoot,'ui');
 if(!path.isAbsolute(dataDir)||!path.isAbsolute(home))throw new RuntimeError('INVALID_RUNTIME_PATH');
 const request=options.nativeRequest||nativeHttpClient(port);
 const native=nativeOnboarding({dataDir,request});
 const manager=options.manager||createManager({dataDir,home,packageRoot,env:options.env||process.env,onboarding:native});
 const stateDir=path.join(dataDir,'paseo');
 const registrationFile=path.join(stateDir,'host-registration.json');
 const mcpReceiptFile=path.join(stateDir,'host-mcp.json');
 let operation=null,reconcileTimer=null,stopped=false,generation=0,uninstalling=false;
 let hostQueue=Promise.resolve(),reconciling=null,shutdownPromise=null,uninstallPromise=null;
 const installed=()=>pluginVerified(getInstalledPluginRecord?.(),path.join(dataDir,'plugins'));
 const mcp=options.mcpConfig||null;
 const desiredEntry={id:MCP_ID,label:'WoowTech Paseo',transport:'stdio',enabled:true,command:process.execPath,args:[path.join(packageRoot,'bin/mcp.mjs')],env:{HOME:path.resolve(home),OPENDESIGN_PASEO_DATA_DIR:path.resolve(dataDir)}};
 const sameEntry=(a,b)=>a?.command===b?.command&&JSON.stringify(a?.args)===JSON.stringify(b?.args)&&a?.transport===b?.transport;
 const checkGeneration=epoch=>{if(stopped||epoch!==generation)throw new RuntimeError('OPERATION_ABORTED');};
 const enqueue=work=>{
  if(stopped)return Promise.reject(new RuntimeError('SERVICE_DISPOSED'));
  const pending=hostQueue.then(work);hostQueue=pending.catch(()=>{});return pending;
 };
 const invalidate=()=>{
  generation++;manager.cancelQueuedOperations?.();
  if(operation?.status==='running')operation={...operation,status:'interrupted',code:'OPERATION_INTERRUPTED',completedAt:new Date().toISOString()};
 };
 const mergeMcp=async(remove=false,epoch=generation)=>{
  checkGeneration(epoch);
  if(!mcp?.writeMcpConfig)return;
  const receipt=read(mcpReceiptFile);
  await mcp.writeMcpConfig(dataDir,previous=>{
   checkGeneration(epoch);
   const servers=previous.servers||[],old=servers.find(row=>row.id===MCP_ID);
   if(old&&!sameEntry(old,desiredEntry)&&!sameEntry(old,receipt.entry))throw new RuntimeError('CONFIG_MCP_CONFLICT');
   const rows=servers.filter(row=>row.id!==MCP_ID);
   if(!remove)rows.push({...desiredEntry,...(old?{enabled:old.enabled!==false}:{})});
   return {...previous,servers:rows};
  });
  checkGeneration(epoch);
  atomicJson(mcpReceiptFile,{entry:desiredEntry,removed:remove,updatedAt:new Date().toISOString()});
 };
 const status=async()=>{
  const hostOperation=operation?{...operation}:null;
  const value=await manager.status(),current=value.operation;
  const hostWins=hostOperation&&(hostOperation.status==='running'||!current||current.status!=='running'&&
   Date.parse(hostOperation.completedAt||hostOperation.startedAt)>=Date.parse(current.completedAt||current.startedAt));
  return {...value,pluginInstalled:installed(),...(hostWins?{operation:hostOperation}:{})};
 };
 const schedule=(action,work)=>{
  if(stopped||uninstalling)throw new BridgeError('OPERATION_BUSY',409);
  if(operation?.status==='running')throw new BridgeError('OPERATION_BUSY',409);
  const epoch=generation,record={id:randomUUID(),action,status:'running',startedAt:new Date().toISOString()};operation=record;
  void enqueue(async()=>{checkGeneration(epoch);const result=await work(epoch);checkGeneration(epoch);return result;}).then(
   ()=>{if(operation?.id===record.id)operation={...record,status:'completed',completedAt:new Date().toISOString()};},
   error=>{if(operation?.id===record.id&&operation.status==='running')operation={...record,status:'error',code:publicError(error).error.code,completedAt:new Date().toISOString()};});
  return {scheduled:true,operation:{...record}};
 };
 const enable=async(epoch)=>{checkGeneration(epoch);if(!installed())throw new RuntimeError('CONFIG_PLUGIN_NOT_INSTALLED');await mergeMcp(false,epoch);checkGeneration(epoch);return manager.enable();};
 const reconcileWork=async({autoEnable=false}={})=>{
  if(stopped||uninstalling)return;
  const record=read(registrationFile),present=installed();
  if(!present){
   const state=await manager.status();
   if(record.registered||state.desiredEnabled||state.daemon?.owned&&state.daemon?.running){
    invalidate();const epoch=generation;
    await manager.disable();await mergeMcp(true,epoch);atomicJson(registrationFile,{...record,registered:false,updatedAt:new Date().toISOString()});
   }
   return;
  }
  if(!record.registered||(!record.activatedOnce&&autoEnable))atomicJson(registrationFile,{...record,registered:true,activatedOnce:record.activatedOnce||autoEnable,updatedAt:new Date().toISOString()});
  if(autoEnable&&!record.activatedOnce&&operation?.status!=='running')schedule('enable',enable);
 };
 const reconcile=()=>{
  if(stopped||uninstalling)return Promise.resolve();
  if(reconciling)return reconciling;
  const epoch=generation;
  reconciling=enqueue(async()=>{checkGeneration(epoch);return reconcileWork();}).finally(()=>{reconciling=null;});return reconciling;
 };
 app.get('/paseo/setup',(_req,res)=>{
  setPrivateHeaders(res);res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return res.sendFile('setup.html',{root:uiRoot,dotfiles:'deny'});
 });
 const assets={'setup.js':'setup.js','setup.css':'setup.css','entry.js':'native-entry.js'};
 for(const [url,file] of Object.entries(assets))app.get(`/paseo/assets/${url}`,(_req,res)=>{setPrivateHeaders(res);res.sendFile(file,{root:uiRoot,dotfiles:'deny'});});
 app.get('/paseo/entry.js',(_req,res)=>{setPrivateHeaders(res);res.sendFile('native-entry.js',{root:uiRoot,dotfiles:'deny'});});
 app.get('/api/paseo-bridge',(req,res)=>{
  if(!requestAllowed(req,allowedOrigins))return json(res,publicError(new BridgeError('UNTRUSTED_REQUEST')),403);
  void status().then(value=>json(res,value),error=>json(res,publicError(error),503));
 });
 app.post('/api/paseo-bridge',(req,res)=>{
  if(!requestAllowed(req,allowedOrigins))return json(res,publicError(new BridgeError('UNTRUSTED_REQUEST')),403);
  void (async()=>{
   const body=validateAction(req.body);
   if(body.action==='status')return json(res,await status());
   if(stopped||uninstalling)throw new BridgeError('OPERATION_BUSY',409);
   if(body.action==='enable')return json(res,schedule('enable',enable),202);
   if(body.action==='disable'){invalidate();return json(res,schedule('disable',()=>manager.disable()),202);}
   if(body.action==='acceptance'){const {action,...input}=body;return json(res,schedule('acceptance',()=>manager.acceptance(input)),202);}
   if(body.action==='models')return json(res,await manager.models(body.provider));
   if(body.action==='pair'){
    const result=await manager.pair(),url=safePairUrl(result.url);if(!url)throw new BridgeError('PAIRING_UNAVAILABLE',502);
    return json(res,{url,...(result.expiresAt?{expiresAt:result.expiresAt}:{})});
   }
   if(body.action==='login')return json(res,await manager.login(body.step||'start',body.provider,body.code===undefined?{}:{code:body.code}));
   if(body.action==='onboarding')return json(res,await manager.ensureOnboarding());
  })().catch(error=>json(res,publicError(error),error.status||503));
 });
 // Native installer retains its authority checks and response stream. Only a
 // successful request followed by a verified registry lookup reconciles state.
 app.use((req,res,next)=>{
  const epoch=generation;
  if(req.method==='POST'&&(req.path==='/api/plugins/install'||req.path===`/api/plugins/${PLUGIN_ID}/upgrade`))res.once('finish',()=>{
   if(res.statusCode>=400||stopped||epoch!==generation||!installed())return;
   void enqueue(async()=>{checkGeneration(epoch);uninstalling=false;uninstallPromise=null;await reconcileWork({autoEnable:true});}).catch(()=>{});
  });
  next();
 });
 const lifecycle={
  start(){
   if(stopped||reconcileTimer)return;
   const epoch=generation;
   void enqueue(async()=>{checkGeneration(epoch);await reconcileWork();checkGeneration(epoch);if(installed()&&!uninstalling){await mergeMcp(false,epoch);checkGeneration(epoch);await manager.restore();}}).catch(()=>{});
   reconcileTimer=setInterval(()=>{void reconcile().catch(()=>{});},5000);reconcileTimer.unref();
  },
  disarm(){if(stopped)return;stopped=true;generation++;clearInterval(reconcileTimer);reconcileTimer=null;manager.cancelPending?.();},
  shutdown(){if(shutdownPromise)return shutdownPromise;this.disarm();shutdownPromise=hostQueue.then(()=>manager.shutdown());return shutdownPromise;},
  beforeUninstall(id){
   if(id!==PLUGIN_ID)return Promise.resolve();
   if(uninstallPromise)return uninstallPromise;
   if(stopped)return Promise.reject(new RuntimeError('SERVICE_DISPOSED'));
   uninstalling=true;invalidate();const epoch=generation;
   uninstallPromise=enqueue(async()=>{checkGeneration(epoch);await manager.disable();await mergeMcp(true,epoch);const record=read(registrationFile);atomicJson(registrationFile,{...record,registered:false,activatedOnce:false,updatedAt:new Date().toISOString()});});
   void uninstallPromise.catch(()=>{uninstallPromise=null;});
   return uninstallPromise;
  },
  manager,
 };
 activeBridge=lifecycle;
 return lifecycle;
}
export async function stopBeforeNativeUninstall(id){return activeBridge?.beforeUninstall(id);}
