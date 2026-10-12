import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {requestAllowed, readBody, validateAction, safePairUrl, publicError} from '../host/security.mjs';

const origin='https://od.example.test';
const req=(headers={})=>({headers,method:'POST'});
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
 for(const input of [{action:'exec',command:'id'},{action:'models',provider:'unknown'},{action:'login',provider:'codex',command:'sh'},{action:'enable',cwd:'/etc'}])assert.throws(()=>validateAction(input));
});
test('pairing only permits official HTTPS origin without embedded credentials',()=>{
 assert.equal(safePairUrl('https://app.paseo.sh/?offer=private'),'https://app.paseo.sh/?offer=private');
 for(const value of ['http://app.paseo.sh/','https://app.paseo.sh.evil.test/','https://u:p@app.paseo.sh/','javascript:alert(1)'])assert.equal(safePairUrl(value),null);
});
test('unexpected errors never disclose command stderr, credentials or pairing URLs',()=>{
 const output=publicError(Object.assign(new Error('password secret https://app.paseo.sh/?offer=private'),{code:'PRIVATE https://secret'}));
 assert.equal(JSON.stringify(output).includes('secret'),false);
 assert.equal(output.error.code,'OPERATION_FAILED');
});
