import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson, assertSafePath, RuntimeError} from '../vendor/pi-paseo/src/state.mjs';

export function nativeHttpClient(port,{fetchImpl=fetch,timeoutMs=15000}={}){
 if(!Number.isInteger(port)||port<1024||port>65535)throw new RuntimeError('INVALID_PORT');
 return async(method,route,body)=>{
  if(!['GET','POST','PUT','PATCH'].includes(method)||!route.startsWith('/api/')||route.includes('://')||/[\r\n]/.test(route))throw new RuntimeError('INVALID_NATIVE_ROUTE');
  const response=await fetchImpl(`http://127.0.0.1:${port}${route}`,{method,headers:{'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
  if(response.status===404&&method==='GET')return null;
  if(!response.ok)throw new RuntimeError('ONBOARDING_NATIVE_REQUEST_FAILED');
  return response.json();
 };
}
function readRecord(file){
 assertSafePath(file);
 try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw new RuntimeError('ONBOARDING_STATE_CORRUPT');}
}
export function nativeOnboarding({dataDir,request}){
 const file=path.join(dataDir,'paseo','native-onboarding.json');
 const title='Paseo 連線初始化';
 return async(prompt,remember,known={})=>{
  let record=readRecord(file);
  if(known.projectId&&record.projectId&&known.projectId!==record.projectId)throw new RuntimeError('ONBOARDING_ID_MISMATCH');
  record.projectId ||= known.projectId||randomUUID();
  record.installationMarker ||= randomUUID();
  atomicJson(file,record);
  // Native project IDs are client-selected, so preserve this exact intent
  // before the request and reconcile it if a create response is lost.
  remember({projectId:record.projectId});
  const route=`/api/projects/${encodeURIComponent(record.projectId)}`;
  let project=await request('GET',route);
  if(!project){
   record.creatingProject=true;atomicJson(file,record);
   const created=await request('POST','/api/projects',{id:record.projectId,name:title,conversationMode:'chat',skipDiscoveryBrief:true,metadata:{kind:'prototype',woowPaseoInstallation:record.installationMarker}});
   if(typeof created?.conversationId==='string'){
    record.conversationId=created.conversationId;atomicJson(file,record);
    remember({projectId:record.projectId,conversationId:record.conversationId,url:`/projects/${record.projectId}/conversations/${record.conversationId}`});
   }
   project=await request('GET',route);
  }
  const found=project?.project||project;
  if(found?.id!==record.projectId||found?.metadata?.woowPaseoInstallation!==record.installationMarker)throw new RuntimeError('ONBOARDING_PROJECT_NOT_OWNED');
  remember({projectId:record.projectId});
  const list=await request('GET',`${route}/conversations`);
  const conversations=list?.conversations||[];
  if(record.conversationId){if(!conversations.some(row=>row.id===record.conversationId))throw new RuntimeError('ONBOARDING_CONVERSATION_MISSING');}
  else{
   // Native project creation atomically creates its initial conversation. If
   // the response was lost, reconcile that same conversation; never POST a
   // second one merely because the bridge did not receive the first response.
   const matches=conversations.length===1?conversations:conversations.filter(row=>row.title===title&&row.sessionMode==='chat');
   if(matches.length!==1)throw new RuntimeError('ONBOARDING_UNCERTAIN');
   record.conversationId=matches[0].id;atomicJson(file,record);
  }
  const result={projectId:record.projectId,conversationId:record.conversationId,url:`/projects/${encodeURIComponent(record.projectId)}/conversations/${encodeURIComponent(record.conversationId)}`};
  remember(result);
  if(!record.seeded){
   await request('PATCH',`${route}/conversations/${encodeURIComponent(record.conversationId)}`,{title,sessionMode:'chat'});
   record.messageId ||= randomUUID();atomicJson(file,record);
   await request('PUT',`${route}/conversations/${encodeURIComponent(record.conversationId)}/messages/${encodeURIComponent(record.messageId)}`,{id:record.messageId,role:'assistant',content:`Paseo 的安裝與連線由受保護設定頁處理。請開啟 [設定 Paseo](/paseo/setup)，查看 provider 登入、配對與對話驗證。\n\n${prompt}`,createdAt:Date.now(),createOnly:true});
   record.seeded=true;atomicJson(file,record);
  }
  return result;
 };
}
