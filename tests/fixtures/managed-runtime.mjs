import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {BRAND_SERVER_PATH} from '../../vendor/pi-paseo/src/brand-identity-patch.mjs';
import {markRuntimeReady,runtimeDirectory} from '../../vendor/pi-paseo/src/runtime-layout.mjs';

// The exact Apache-2.0-licensed @getpaseo/server 0.17.5 npm file. A frozen real
// server is needed because the production patch rejects unknown source bytes.
export const upstreamServer=()=>gunzipSync(fs.readFileSync(new URL('./getpaseo-server-0.17.5-websocket-server.js.gz',import.meta.url)));
export function readyFixture(loc) {
 const file=path.join(runtimeDirectory(loc),BRAND_SERVER_PATH);
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,upstreamServer());
 markRuntimeReady(loc);
}
