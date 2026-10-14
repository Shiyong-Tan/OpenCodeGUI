import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LinuxServiceOwner } = require('../out/transport/LinuxServiceOwner.js');
const directory = await mkdtemp(join(tmpdir(), 'gui-linux-service-test-'));
const owner = new LinuxServiceOwner(directory);
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
let identity;
try {
  const release = await owner.acquire('12'.repeat(32));
  await assert.rejects(owner.acquire('12'.repeat(32)), /operation_busy/); await release();
  const releaseAgain = await owner.acquire('12'.repeat(32)); await releaseAgain();
  identity = await owner.start({ serviceId: '34'.repeat(32), executable: process.execPath,
    args: ['-e', `if(process.env.OPENCODE_GUI_SUPERVISOR_BINDING!=='fixture-binding')process.exit(22);require('http').createServer((q,s)=>s.end('fixture')).listen(${port},'127.0.0.1')`], cwd: directory }, { ...process.env, OPENCODE_GUI_SUPERVISOR_BINDING:'fixture-binding' }, async value => { assert.ok(value.pid > 0); });
  const reloadedOwner = new LinuxServiceOwner(directory);
  let observed;
  for (let i=0;i<30;i++) { observed = await reloadedOwner.inspect(identity, false, port); if (observed.listenerOwned) break; await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.equal(observed.state, 'running'); assert.equal(observed.listenerOwned, true);
  await assert.rejects(reloadedOwner.inspect({ ...identity, creationFileTime: String(BigInt(identity.creationFileTime)+1n) },true,port), /identity_mismatch/);
  await assert.rejects(reloadedOwner.inspect({ ...identity, serviceId: '56'.repeat(32) },true,port), /not_owned/);
  assert.equal((await reloadedOwner.inspect(identity,true,port)).state, 'stopped');
  console.log('PASS WSL GUI service owner: exclusive lock, start identity, reload ownership, listener ownership, rejected PID/marker mismatch, verified stop');
} finally { if (identity) { try { await owner.inspect(identity,true,port); } catch {} } await rm(directory,{recursive:true,force:true}); }
