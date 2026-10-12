const ACTIONS = new Set(['status','enable','disable','models','pair','acceptance','login','onboarding']);
const PROVIDERS = new Set(['claude','codex','pi']);
const CODES = new Set(['INVALID_ACTION','INVALID_BODY','INVALID_PROVIDER','INVALID_JSON','BODY_TOO_LARGE','CONTENT_TYPE_REQUIRED','UNTRUSTED_REQUEST','OPERATION_BUSY','PAIRING_UNAVAILABLE','LOGIN_REQUIRED','LOGIN_UNAVAILABLE','DAEMON_UNREACHABLE','ONBOARDING_UNCERTAIN','HOST_NOT_COMPATIBLE']);
export class BridgeError extends Error {
 constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
function canonicalOrigin(value){
 try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash?u.origin:null;}catch{return null;}
}
export function requestAllowed(req,allowedOrigins=[]){
 const site=req.headers['sec-fetch-site'];
 if(site&&site!=='same-origin'&&site!=='none')return false;
 const origin=req.headers.origin;
 if(origin===undefined)return true;
 if(typeof origin!=='string')return false;
 const canonical=canonicalOrigin(origin);
 return canonical!==null&&allowedOrigins.some(value=>canonicalOrigin(value)===canonical);
}
export async function readBody(req,maxBytes=16384){
 const type=String(req.headers['content-type']||'').split(';',1)[0].trim().toLowerCase();
 if(type!=='application/json'&&!(type.startsWith('application/')&&type.endsWith('+json')))throw new BridgeError('CONTENT_TYPE_REQUIRED',415);
 const claimed=Number(req.headers['content-length']);
 if(Number.isFinite(claimed)&&claimed>maxBytes)throw new BridgeError('BODY_TOO_LARGE',413);
 let bytes=0;const chunks=[];
 const input=typeof req.iterator==='function'?req.iterator({destroyOnReturn:false}):req;
 for await(const chunk of input){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>maxBytes)throw new BridgeError('BODY_TOO_LARGE',413);chunks.push(buffer);}
 let body;try{body=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch{throw new BridgeError('INVALID_JSON');}
 if(!body||typeof body!=='object'||Array.isArray(body))throw new BridgeError('INVALID_BODY');
 return body;
}
export function validateAction(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||!ACTIONS.has(body.action))throw new BridgeError('INVALID_ACTION');
 const fields=new Set(['action']);
 if(['models','login'].includes(body.action))fields.add('provider');
 if(body.action==='login'){fields.add('step');fields.add('code');}
 if(body.action==='acceptance')for(const key of ['providers','models','modes','timeoutMs'])fields.add(key);
 if(Object.keys(body).some(key=>!fields.has(key)))throw new BridgeError('INVALID_BODY');
 if(fields.has('provider')&&!PROVIDERS.has(body.provider))throw new BridgeError('INVALID_PROVIDER');
 if(body.step!==undefined&&!['start','status','cancel','complete'].includes(body.step))throw new BridgeError('INVALID_BODY');
 if(body.code!==undefined&&(typeof body.code!=='string'||body.code.length>2048||/[\u0000-\u001f]/.test(body.code)))throw new BridgeError('INVALID_BODY');
 if(body.providers!==undefined&&(!Array.isArray(body.providers)||!body.providers.length||body.providers.length>3||body.providers.some(value=>!PROVIDERS.has(value))))throw new BridgeError('INVALID_PROVIDER');
 for(const key of ['models','modes'])if(body[key]!==undefined){
  const map=body[key];if(!map||typeof map!=='object'||Array.isArray(map)||Object.entries(map).some(([provider,value])=>!PROVIDERS.has(provider)||typeof value!=='string'||value.length>300||/[\u0000-\u001f]/.test(value)))throw new BridgeError('INVALID_BODY');
 }
 if(body.timeoutMs!==undefined&&(!Number.isFinite(body.timeoutMs)||body.timeoutMs<10000||body.timeoutMs>600000))throw new BridgeError('INVALID_BODY');
 return {...body};
}
export function safePairUrl(value){
 if(typeof value!=='string'||value.length>8192)return null;
 try{const u=new URL(value);return u.origin==='https://app.paseo.sh'&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
export function publicError(error){
 const code=CODES.has(error?.code)?error.code:'OPERATION_FAILED';
 return {error:{code,message:'操作尚未完成，請查看診斷並重試。'}};
}
export function setPrivateHeaders(res){
 res.setHeader('Cache-Control','private, no-store');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('X-Content-Type-Options','nosniff');
}
