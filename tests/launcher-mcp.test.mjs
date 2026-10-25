import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeMcpConfig} from '../host/native-mcp.mjs';

const own={id:'woow-paseo',transport:'stdio',command:'node',args:['/opt/paseo/bin/mcp.mjs'],enabled:true};
test('CAS mutation sends only its entry and rereads on a concurrent change',async()=>{
 let reads=0;const puts=[];
 const request=async(method,route,body)=>{
  if(method==='GET'){reads++;return {servers:[{id:'peer',command:'untouched'},...(reads>1?[{...own,enabled:false}]:[])]};}
  assert.equal(route,'/api/mcp/servers/woow-paseo');puts.push(body);
  if(puts.length===1)throw {status:409};
  return {};
 };
 const cfg=nativeMcpConfig(request);
 await cfg.writeMcpConfig('',previous=>({servers:[...previous.servers.filter(r=>r.id!==own.id),{...own,label:'Paseo',enabled:previous.servers.find(r=>r.id===own.id)?.enabled!==false}]}));
 assert.equal(reads,2);assert.equal(puts.length,2);assert.equal(puts[0].expected,null);
 assert.equal(puts[1].server.enabled,false);assert.deepEqual(puts[1].expected,{...own,enabled:false});
 assert.equal(JSON.stringify(puts).includes('untouched'),false);
});
test('unavailable CAS API never falls back to replacing the whole MCP config',async()=>{
 const writes=[];const cfg=nativeMcpConfig(async(method,route)=>{if(method==='GET')return {servers:[]};writes.push(route);throw {status:404};});
 await assert.rejects(cfg.writeMcpConfig('',()=>({servers:[own]})),{code:'CONFIG_MCP_UNAVAILABLE'});
 assert.deepEqual(writes,['/api/mcp/servers/woow-paseo']);
});
test('peer mutations and duplicate owned IDs are rejected without a write',async()=>{
 for(const rows of [[{id:'peer',command:'changed'},own],[{id:'peer',command:'original'},own,own]]){
  const cfg=nativeMcpConfig(async(method)=>{assert.equal(method,'GET');return {servers:[{id:'peer',command:'original'}]};});
  await assert.rejects(cfg.writeMcpConfig('',()=>({servers:rows})),{code:'CONFIG_MCP_CONFLICT'});
 }
});
test('owned deletion uses the same atomic expectation boundary',async()=>{
 let actual;const cfg=nativeMcpConfig(async(method,_route,body)=>{if(method==='GET')return {servers:[own]};actual=body;return {};});
 await cfg.writeMcpConfig('',()=>({servers:[]}));assert.deepEqual(actual,{server:null,expected:own});
});
