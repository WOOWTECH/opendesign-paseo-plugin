import test from 'node:test';
import assert from 'node:assert/strict';
import {redactText} from '../src/public-dto.mjs';

test('public text redacts pairing links for every Agent Connect client',()=>{
 const output=redactText(['https://app.paseo.sh/#offer=PASEO_SECRET','https://smart.woowtech.io/#offer=WOOW_SECRET','https://smart.apporo.ai/#offer=APPORO_SECRET'].join(' '));
 assert.equal((output.match(/\[protected pairing link\]/g)||[]).length,3);
 assert.doesNotMatch(output,/PASEO_SECRET|WOOW_SECRET|APPORO_SECRET/);
});
