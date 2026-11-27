import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {requestAllowed, readBody, validateAction, safePairUrl, publicError} from '../host/security.mjs';
import {connectionTarget} from '../src/client-targets.mjs';

const origin='https://od.example.test';
const req=(headers={})=>({headers,method:'POST'});
const offer=target=>{
 const profile=connectionTarget(target);
 const payload={v:2,serverId:'server-fixture',daemonPublicKeyB64:'public-key-fixture',relay:{endpoint:profile.relayEndpoint,useTls:true},...(profile.protectedRelay?{minimumSecurityMode:'protected'}:{})};
 return `${profile.appUrl}/#offer=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
};
test('rejects cross-site, null and malformed origins while allowing native same-origin requests',()=>{
 assert.equal(requestAllowed(req({origin}),[origin]),true);
 for(const headers of [{origin:'null'},{origin:'https://evil.example.test'},{origin:origin+'/path'},{origin,'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}])assert.equal(requestAllowed(req(headers),[origin]),false);
 assert.equal(requestAllowed(req({}),[origin]),true);
});
test('JSON body limit is enforced during streaming, including untrusted content-length',async()=>{
 const make=(text,headers)=>Object.assign(Readable.from([Buffer.from(text)]),{headers});
 assert.deepEqual(await readBody(make('{"action":"models","provider":"pi"}',{'content-type':'application/json'})),{action:'models',provider:'pi'});
 await assert.rejects(readBody(make('x'.repeat(17000),{'content-type':'application/json','content-length':'2'})),{code:'BODY_TOO_LARGE',status:413});
 await assert.rejects(readBody(make('{"password":"never echo this"',{'content-type':'application/json'})),{code:'INVALID_JSON',status:400});
 await assert.rejects(readBody(make('{}',{'content-type':'text/plain'})),{code:'CONTENT_TYPE_REQUIRED',status:415});
 await assert.rejects(readBody(make('[]',{'content-type':'application/json'})),{code:'INVALID_BODY',status:400});
});
test('actions and provider inputs are validated before any manager mutation',()=>{
 assert.deepEqual(validateAction({action:'models',provider:'codex'}),{action:'models',provider:'codex'});
 assert.deepEqual(validateAction({action:'pair'}),{action:'pair'});
 assert.deepEqual(validateAction({action:'pair',target:'woowtech'}),{action:'pair',target:'woowtech'});
 assert.deepEqual(validateAction({action:'target',target:'apporo'}),{action:'target',target:'apporo'});
 for(const input of [{action:'exec',command:'id'},{action:'models',provider:'unknown'},{action:'login',provider:'codex',command:'sh'},{action:'enable',cwd:'/etc'}])assert.throws(()=>validateAction(input));
 for(const input of [{action:'target'},{action:'target',target:'unknown'},{action:'pair',target:'https://smart.woowtech.io'}])assert.throws(()=>validateAction(input));
});
test('pairing validates full v2 payload against the selected client profile',()=>{
 for(const target of ['paseo','woowtech','apporo'])assert.equal(safePairUrl(offer(target),target),offer(target));
 assert.equal(safePairUrl(offer('woowtech'),'apporo'),null);
 const wrongRelay=offer('woowtech').replace('smart.woowtech.io','smart.apporo.ai');
 for(const value of [wrongRelay,'http://app.paseo.sh/','https://u:p@app.paseo.sh/','https://app.paseo.sh:444/','javascript:alert(1)'])assert.equal(safePairUrl(value,'paseo'),null);
});
test('unexpected errors never disclose command stderr, credentials or pairing URLs',()=>{
 const output=publicError(Object.assign(new Error('password secret https://app.paseo.sh/?offer=private'),{code:'PRIVATE https://secret'}));
 assert.equal(JSON.stringify(output).includes('secret'),false);
 assert.equal(output.error.code,'OPERATION_FAILED');
});
