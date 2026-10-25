import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {startOwnedSupervisor} from '../src/owned-supervisor.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('actual npm archive contains and runs the lifecycle supervisor',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-package-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const packed=spawnSync('npm',['pack','--json','--pack-destination',dir],{cwd:root,encoding:'utf8',timeout:30000});assert.equal(packed.status,0);
 const archive=JSON.parse(packed.stdout)[0];
 assert.equal(spawnSync('tar',['-xzf',path.join(dir,archive.filename),'-C',dir]).status,0);
 const home=path.join(dir,'home');fs.mkdirSync(home);
 const result=spawnSync(process.execPath,[path.join(dir,'package/bin/supervise.mjs')],{
  cwd:home,encoding:'utf8',timeout:10000,
  env:{PATH:process.env.PATH,HOME:home,OPENDESIGN_PASEO_DATA_DIR:path.join(dir,'data'),OPENDESIGN_PASEO_PACKAGE_ROOT:path.join(dir,'package')},
 });
 assert.equal(result.status,0,`packaged supervisor failed: ${result.stderr}`);
});
test('missing supervisor entry fails before claiming that a child was started',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-missing-supervisor-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 await assert.rejects(startOwnedSupervisor({stateDir:dir,packageRoot:dir,toolsDir:dir,sourceStore:dir,home:dir}),{code:'SUPERVISOR_UNAVAILABLE'});
 assert.equal(fs.existsSync(path.join(dir,'supervisor.json')),false);
});
