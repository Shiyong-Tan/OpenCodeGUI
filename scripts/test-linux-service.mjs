import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
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
    args: ['-e', `if(process.env.OPENCODE_GUI_SUPERVISOR_BINDING!=='fixture-binding')process.exit(22);process.stdout.write('startup fixture-binding\\n');setTimeout(()=>process.stderr.write('late diagnostic\\n'),250);require('http').createServer((q,s)=>{process.stdout.write('x'.repeat(80000)+'\\n');s.end('fixture');}).listen(${port},'127.0.0.1')`], cwd: directory }, { ...process.env, OPENCODE_GUI_SUPERVISOR_BINDING:'fixture-binding' }, async value => { assert.ok(value.pid > 0); });
  const reloadedOwner = new LinuxServiceOwner(directory);
  let observed;
  for (let i=0;i<30;i++) { observed = await reloadedOwner.inspect(identity, false, port); if (observed.listenerOwned) break; await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.equal(observed.state, 'running'); assert.equal(observed.listenerOwned, true);
  await new Promise(resolve=>setTimeout(resolve,400));
  const startupFile = owner.startupLogPath(identity.serviceId);
  const output = await readFile(startupFile, 'utf8');
  assert.ok(output.includes('startup ***************\n')); assert.ok(output.includes('late diagnostic\n'));
  assert.equal(output.includes('fixture-binding'),false);
  assert.equal((await stat(startupFile)).mode & 0o777, 0o600);
  // The output limit must not close the pipe or interrupt a still-running service.
  const http = await import('node:http');
  await new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${port}`, response=>{response.resume();response.on('end',resolve);}).on('error',reject));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await stat(startupFile)).size,65536);
  assert.equal((await reloadedOwner.inspect(identity,false,port)).state,'running');
  await assert.rejects(reloadedOwner.inspect({ ...identity, creationFileTime: String(BigInt(identity.creationFileTime)+1n) },true,port), /identity_mismatch/);
  await assert.rejects(reloadedOwner.inspect({ ...identity, serviceId: '56'.repeat(32) },true,port), /not_owned/);
  assert.equal((await reloadedOwner.inspect(identity,true,port)).state, 'stopped');
  console.log('PASS WSL GUI service owner: exclusive lock, start identity, reload ownership, listener ownership, rejected PID/marker mismatch, verified stop');
} finally { if (identity) { try { await owner.inspect(identity,true,port); } catch {} } await rm(directory,{recursive:true,force:true}); }
