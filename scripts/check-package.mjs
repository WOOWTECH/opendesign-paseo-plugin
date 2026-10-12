#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for(const name of ['SKILL.md','open-design.json']) assert.equal(fs.readFileSync(path.join(root,name),'utf8'),fs.readFileSync(path.join(root,'plugin',name),'utf8'),`Plugin root differs: ${name}`);
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'open-design.json')));
assert.equal(pkg.version,manifest.version);
assert.equal(manifest.name,'woowtech-paseo');
const files=[];
function visit(relative){
 for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  const name=path.join(relative,entry.name);
  if(entry.isDirectory()) visit(name);
  else if(entry.isFile() && /\.(?:mjs|js)$/.test(name)) files.push(name);
 }
}
for(const directory of ['bin','src','host','ui','scripts','tests','vendor/pi-paseo/src']) visit(directory);
for(const file of files){
 const result=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,`Syntax check failed: ${file}`);
}
const result=spawnSync('npm',['pack','--dry-run','--json'],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
assert.equal(result.status,0,'npm pack failed');
const packed=JSON.parse(result.stdout)[0];
for(const {path:file} of packed.files){
 assert(!/(?:^|\/)(?:node_modules|\.private|\.git|evidence|worktrees|\.cache)(?:\/|$)/.test(file),`Unexpected private path: ${file}`);
 assert(!/(?:auth\.json|browser-auth|acceptance-config\.json|\.env|\.pem|\.key)$/.test(file),`Credential-like artifact: ${file}`);
 const content=fs.readFileSync(path.join(root,file),'utf8');
 assert(!/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(content),`Token-like artifact: ${file}`);
}
for(const file of ['SKILL.md','open-design.json','host/compatibility.json','bin/preload.mjs','src/flock-helper.py','vendor/pi-paseo/runtime/package-lock.json']) assert(packed.files.some(entry=>entry.path===file),`Missing artifact: ${file}`);
console.log(JSON.stringify({passed:true,syntaxFiles:files.length,packageFiles:packed.files.length,packageBytes:packed.unpackedSize,version:pkg.version}));
