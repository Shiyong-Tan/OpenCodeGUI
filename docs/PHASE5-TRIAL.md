# Phase 5: normal installed GUI trial

Supported trial: Windows, OpenCode **1.18.29 or 1.18.31**, GUI **5.0.7**. The original
phase-five acceptance used the 5.0.5 commits recorded in the companion supervisor
repository; 5.0.6 packages that implementation as a distinct GUI release. VS Code 1.137.0 was
actually exercised. This is a small-workspace trial, not long-term production
certification. No global installation, production deployment or automatic upgrade
is performed.

## Install and enable

Install `opencode-gui-5.0.7.vsix` from the OpenCodeGUI repository using
**Extensions: Install from VSIX...**, then reload when prompted. This updates the
GUI extension, not OpenCode or the separately installed supervisor plugin. Start
with a non-critical workspace. To reproduce the package from this repository,
run `npm.cmd ci`, `npm.cmd run compile`, then
`npx.cmd --yes @vscode/vsce@3.9.1 package --out opencode-gui-5.0.7.vsix`.
Run the repository test and Webview gates before distributing a rebuilt package.

Build the supervisor with `npm.cmd ci`, `npm.cmd test`, `npm.cmd run typecheck`
and `npm.cmd run build`. Retain its dependency directory and complete `dist` tree.
Merge this item into the intended workspace's OpenCode `plugin` array, using the
actual installation file URL:

```json
["file:///D:/Tools/OpenCodeTaskSupervisor/dist/plugin.js", {
  "normalGui": { "enabled": true }
}]
```

This local options tuple was verified with OpenCode 1.18.29 and 1.18.31. See [the compatibility audit](OPENCODE-1.18.31.md); rebuild the companion Supervisor too. It defaults to
observation; dispatch and model-triggering notifications require separate explicit
plugin options and authorization. The GUI switch does not authorize those actions.

Install the compatible ordinary VSIX through **Extensions: Install from VSIX…**
in a separate test profile. Enable the existing **OpenCode › Supervisor: Enabled**
setting (`opencode.supervisor.enabled`, default false), then open the sidebar.
No descriptor or copied authentication key is needed. A running service needs an
explicit restart to load changed plugin configuration or a new launch binding.

Building the GUI locally requires its locked npm dependencies and the standard
Windows .NET Framework C# compiler used by `scripts/build-service-job.js`. Run
`npm.cmd ci`, the four standard validation gates, then package with VSCE. The
package must include `out/native/ServiceJob.exe` and runtime npm dependencies.
Do not use `--no-dependencies` when packaging this extension.

## Service commands

Use `Ctrl+Shift+P`:

- **OpenCode: Start Service** starts a stopped owned service or reconnects to the
  already-running owned instance.
- **OpenCode: Stop Service** requires verified private-profile ownership, OS
  creation time, Job membership and listener identity. Success requires root exit
  and zero active Job members.
- **OpenCode: Restart Service** proves the old instance stopped before replacing
  it, then authenticates the new supervisor bridge.

Active, retrying or permission-waiting tasks require an impact confirmation. It
expires after 15 seconds; a late answer cannot stop a service. Unknown activity or
ownership fails closed. Commands are serialized across windows; duplicate requests
do not replace a new generation. The operation response deadline is 45 seconds.
Coordinate other clients before stopping: activity queries and OS termination are
not an atomic OpenCode transaction.

Closing/reloading the GUI, changing workspace or disabling supervision does **not**
stop OpenCode. Reopen the same profile and workspace to reconnect. External services
and legacy unregistered services are never adopted or stopped. Ask their original
owner to manage them. Do not delete locks, ownership records or secrets to bypass a
refusal. Unknown startup outcomes and the 128-generation trial record cap require
diagnostic review; there is no automatic pruning or force-stop fallback.

## Disable, uninstall and roll back

- Clear the GUI supervision setting to stop its live polling/subscriptions. It
  preserves history and trusted notification classification, and does not stop the
  plugin, service or tasks.
- To disable/uninstall the backend, finish tasks and save results, remove only its
  plugin configuration entry, then explicitly restart the owned service. A config
  edit or GUI reload alone does not unload a running plugin.
- On disconnect, observations become historical/unknown, not proof of completion.
  Service restart does not recover the plugin's in-memory task Registry.
- Keep profile provenance storage when rolling back. Stop backend notifications
  first; older Phase 4 builds cannot reliably classify normal-mode v2 notifications.
  Do not downgrade a running supervisor conversation or delete its identity keys.

## Evidence and limits

The companion repository's `docs/PHASE5-RESULTS.md` and
`docs/evidence/phase5-current-commit-map.json` identify exact commits, VSIX hashes
and validation evidence. Runtime validation: 201 suites / 1555 tests; compile,
original bundle budgets and deterministic build pass. Plugin: 86 tests pass.

Actual ordinary installed GUI checks cover service commands, close/reload retention,
reauthentication, default-off, missing plugin, invalid lease and external refusal.
New GUI process, service restart and reload preserve completed real-model history,
canonical message order, one labelled follow-up and the original 10s/5s clocks.
The active-operation dialog was exercised using a real bounded shell operation
with no model, using VS Code's supported `window.dialogStyle: custom` in the test
profile. The native OS dialog was not automated; the earlier DOM-only probe failure
is retained rather than counted as a pass. Concurrent owner primitives and stale
identity cases use OS/integration tests, not a claimed simultaneous two-window race.

Phase 5 cumulative model use is 16/24; Phase 4 remains 42/42. The new eight-request
model loop completed, but its combined GUI harness failed while looking for the
dialog. Completed tool evidence was read back and then verified in the actual GUI
without another model request. This recovery is not a second paid live run.

No auto-redispatch, production auto-cancel, arbitrary-shell stop guarantee, V2,
unrelated workspace import or long-term production stability is claimed. The
rendering budget remains 76784/76800 bytes; it was not raised.
