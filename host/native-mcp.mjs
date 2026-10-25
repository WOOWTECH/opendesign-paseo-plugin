import {isDeepStrictEqual} from 'node:util';
import {RuntimeError} from '../vendor/pi-paseo/src/state.mjs';

const ownId='woow-paseo';

/** Uses the native per-entry CAS endpoint; never PUTs a full config snapshot. */
export function nativeMcpConfig(request){
 return {async writeMcpConfig(_dataDir,update){
  for(let attempt=0;attempt<3;attempt++){
   const previous=await request('GET','/api/mcp/servers');
   if(!Array.isArray(previous?.servers))throw new RuntimeError('CONFIG_MCP_UNAVAILABLE');
   const next=await update({servers:previous.servers});
   const peers=rows=>rows.filter(row=>row.id!==ownId);
   if(!Array.isArray(next?.servers)||!isDeepStrictEqual(peers(previous.servers),peers(next.servers)))throw new RuntimeError('CONFIG_MCP_CONFLICT');
   const before=previous.servers.filter(row=>row.id===ownId),after=next.servers.filter(row=>row.id===ownId);
   if(before.length>1||after.length>1)throw new RuntimeError('CONFIG_MCP_CONFLICT');
   const expected=before[0]||null,server=after[0]||null;
   if(isDeepStrictEqual(expected,server))return next;
   try{await request('PUT',`/api/mcp/servers/${ownId}`,{server,expected});return next;}
   catch(error){
    if(error.status===409&&attempt<2)continue;
    throw new RuntimeError(error.status===409?'CONFIG_MCP_CONFLICT':'CONFIG_MCP_UNAVAILABLE');
   }
  }
 }};
}
