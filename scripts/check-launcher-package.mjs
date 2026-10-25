import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const pack=spawnSync('npm',['pack','--dry-run','--json'],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
assert.equal(pack.status,0,'package dry run failed');
const result=JSON.parse(pack.stdout)[0];const files=result.files.map(row=>row.path);
for(const required of ['bin/serve.mjs','bin/supervise.mjs','bin/mcp.mjs','host/standalone.mjs','host/native-mcp.mjs','launcher/open-design.json','launcher/SKILL.md','ui/setup.html','src/flock-helper.py','vendor/pi-paseo/runtime/package-lock.json'])assert.ok(files.includes(required),`missing ${required}`);
for(const retired of ['bin/preload.mjs','bin/install-host.mjs','open-design.json','plugin/open-design.json'])assert.ok(!files.includes(retired),`retired installer shipped: ${retired}`);
for(const file of files){
 assert.ok(!/(?:^|\/)(?:node_modules|\.private|evidence|__pycache__)(?:\/|$)/.test(file),`private artifact: ${file}`);
 assert.ok(!/(?:auth\.json|browser-auth|\.env|\.pem|\.key)$/.test(file),`credential artifact: ${file}`);
 const text=fs.readFileSync(path.join(root,file),'utf8');
 assert.ok(!/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(text),`token artifact: ${file}`);
}
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'launcher/open-design.json'))).od.launch.path,'/paseo/setup/');
console.log(JSON.stringify({passed:true,files:files.length,bytes:result.unpackedSize}));
