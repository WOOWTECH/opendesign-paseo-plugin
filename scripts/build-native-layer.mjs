#!/usr/bin/env node
/** Build a source-tracked OCI layer without a privileged Docker daemon.
 * npm ci uses only lock-pinned pure JS dependencies, with lifecycle scripts off.
 * Native TypeScript is compiled from reviewed sources; never rewrite dist text.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const destination=process.argv[2];
assert(destination&&path.isAbsolute(destination),'pass an absolute output directory');
assert(!fs.existsSync(destination),'output directory already exists');
fs.mkdirSync(destination,{recursive:true,mode:0o700});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'od-paseo-layer-'));
const stage=path.join(temp,'layer');fs.mkdirSync(stage);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(command,args,cwd=root){const r=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw new Error(`${command} failed (${r.status})`);return r.stdout;}
try{
 const profile=JSON.parse(fs.readFileSync(path.join(root,'image/native-source/profile.json')));
 assert.equal(ts.version,profile.typescript);
 const packed=JSON.parse(run('npm',['pack','--json','--pack-destination',temp]))[0];
 const payload=path.join(stage,'opt/opendesign-paseo');fs.mkdirSync(payload,{recursive:true});
 run('tar',['-xzf',path.join(temp,packed.filename),'-C',payload,'--strip-components=1']);
 // npm excludes package-lock from npm archives. Include it as a build input.
 fs.copyFileSync(path.join(root,'package-lock.json'),path.join(payload,'package-lock.json'));
 run('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],payload);
 const sources=[];
 for(const file of profile.files){
  const source=fs.readFileSync(path.join(root,'image/native-source',file.source),'utf8');
  assert.equal(sha(source),file.sha256,`source hash mismatch: ${file.source}`);
  const result=ts.transpileModule(source,{fileName:file.source,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,isolatedModules:true,esModuleInterop:true,sourceMap:false}});
  assert.equal((result.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
  const output=path.join(stage,file.target);assert(output.startsWith(stage+path.sep));
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,result.outputText);
  sources.push({...file,outputSha256:sha(result.outputText)});
 }
 const plugin=path.join(stage,'app/plugins/_official/woow/woow-paseo');fs.mkdirSync(plugin,{recursive:true});
 for(const name of ['open-design.json','SKILL.md'])fs.copyFileSync(path.join(root,'launcher',name),path.join(plugin,name));
 const provenance={baseImage:profile.baseImage,nativeSource:profile.nativeSource,typescript:ts.version,files:sources,packageLockSha256:sha(fs.readFileSync(path.join(root,'package-lock.json'))),paseoLockSha256:sha(fs.readFileSync(path.join(root,'vendor/pi-paseo/runtime/package-lock.json')))};
 fs.writeFileSync(path.join(payload,'BUILD.json'),JSON.stringify(provenance,null,2)+'\n');
 const layer=path.join(destination,'native-paseo-layer.tar');
 run('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--mode=u+rwX,go+rX,go-w','-cf',layer,'-C',stage,'.']);
 const receipt={...provenance,layerSha256:sha(fs.readFileSync(layer)),bytes:fs.statSync(layer).size};
 fs.writeFileSync(path.join(destination,'build.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({output:destination,layerSha256:receipt.layerSha256,bytes:receipt.bytes}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
