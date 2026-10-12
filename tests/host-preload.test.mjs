import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {isOpenDesignEntry,verifyRelease} from '../bin/preload.mjs';
import {releaseFixture} from './host-release-fixture.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
test('preload only applies to native OpenDesign entry and leaves other Node tools unchanged',()=>{
 assert.equal(isOpenDesignEntry(['node','apps/daemon/bin/od.mjs'],'/app'),true);assert.equal(isOpenDesignEntry(['node','/app/apps/daemon/dist/cli.js'],'/'),true);
 for(const entry of ['/app/node_modules/codex/cli.js','/home/opendesign/source/bin/mcp.mjs','/tmp/od.mjs'])assert.equal(isOpenDesignEntry(['node',entry]),false);
 assert.equal(isOpenDesignEntry(['node','/app/apps/daemon/bin/od.mjs','--host','127.0.0.1','--port','7457','--no-open']),true);
 for(const args of [['mcp'],['plugin','list'],['mcp','--daemon-url','http://127.0.0.1:7457'],['--help']])assert.equal(isOpenDesignEntry(['node','/app/apps/daemon/bin/od.mjs',...args]),false);
});
test('release receipt rejects altered files, escaping pointers and redirected ancestors before import',async t=>{
 const f=releaseFixture(t),installed=await f.install(),pointer=f.pointer('current');
 assert.equal(verifyRelease(f.base,pointer).packageRoot,installed.releaseRoot);
 const file=path.join(installed.releaseRoot,'host/adapter.mjs');fs.writeFileSync(file,'changed');assert.throws(()=>verifyRelease(f.base,pointer),/INVALID_FILE/);
 assert.throws(()=>verifyRelease(f.base,{...pointer,releaseRoot:'/etc'}),/INVALID_ROOT/);
 fs.unlinkSync(file);fs.symlinkSync('/etc/passwd',file);assert.throws(()=>verifyRelease(f.base,pointer),/INVALID_LINK|UNSAFE_PATH/);
});
