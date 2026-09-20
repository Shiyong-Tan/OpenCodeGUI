# Confirmed supervisor follow-up contract — 2026-09-19

The user selected an independent follow-up turn. Preserve the previous reply,
final identity, elapsed time and persisted history exactly.

After the parent is terminal, a new execution triggered by trusted supervisor
notifications starts an independent turn labelled “监督通知触发”, associated with
its task and notification IDs. Start timing at observable parent model activity;
when precise start time is unavailable, explicitly use first observed activity.
Notification submission alone shows waiting and creates no empty assistant bubble.
Queue waiting time is displayed separately.

Internal notifications are neither user messages nor user append prompts. Classify
only by trusted persisted session/message/notification identity, never by text or
generic synthetic flags. Identical user-authored text remains visible.

Duplicate events cannot create duplicate turns. Multiple notifications handled by
the same parent execution share one turn and accumulate source associations. If the
parent is still active, keep the current turn rules rather than forcing a split.
Session switches, reload and history recovery preserve ownership, order and labels.

Implement within the existing session, finalization and snapshot owners. This
contract does not authorize automatic cancellation, redispatch, snapshot repair or
changes to undo/restore and file rollback. The implementation and lifecycle tests
are still pending; the development transport setting alone does not implement it.

## Development connection boundary

`opencode.experimentalSupervisor` defaults to false and is honored only in an
Extension Development Host. `OPENCODE_GUI_SUPERVISOR_DESCRIPTOR` must point to the
new isolated launcher's private `state/supervisor/connection.json`. The selected
workspace must be that laboratory's `work` directory. Reload after setting changes.

The experiment attaches to the exact authenticated loopback service, checks actual
OpenCode 1.18.29, bypasses normal workspace lock creation and cannot migrate on 401.
It never starts or stops the externally launched service. Instance changes or
workspace changes require reloading the isolated development window; no automatic
takeover or production fallback. The launcher retains service shutdown ownership.

The reader now feeds a throttled, selection-epoch-fenced read-only overlay in a
separate Webview bundle. Unknown evidence remains unknown; disconnect marks cached
evidence historical. Updates do not touch chat DOM or scroll state. There are no
cancel or redispatch controls. Trusted notification classification is wired as
described below; independent follow-up lifecycle integration remains pending.
This is not completed GUI end-to-end acceptance.

Validation checkpoint (2026-09-20): 11 focused tests and compilation pass. The new
bundle is 7,642 bytes (gzip 3,481), within its separate 12/6 KiB limits. Deterministic
production builds pass. The existing unchanged rendering bundle is 81,624 bytes,
above the repository's 75 KiB gate; check:webview fails and its limit is unchanged.
The duplicate configuration contribution discovered during compilation was merged
into the existing configuration object, preserving existing setting declarations.

## Classification implementation checkpoint

Trusted catalog lookup is now wired before realtime mapping and remote-history
formatting. Focused tests preserve a real assistant reply and identical user text
while removing only the internal notification record. Failed trust lookup blocks
the owning ingress lane and reports unavailable supervision; it never downgrades
unverified text into user input. These are automated boundary tests, not GUI E2E.

Remaining lifecycle work must coordinate with the existing ChatEventActorRouter and
TurnFinalizationCoordinator: the old snapshot/finalization must finish before the
client starts another generation. A notification submission must not call startTurn.
Webview setBackendInFlight intentionally refuses terminal generations; starting a
new round must use its lifecycle owner, with persisted source/timing metadata.
No temporary bypass of those terminal guards is implemented here.

Actual isolated VS Code launch is currently blocked by the installed application's
vscode-updating mutex. After 31 seconds it exits with code 1 before workbench load.
No UI acceptance or Phase 4 completion is claimed; manual update completion was
requested. No existing VS Code window or updater process was modified.

Final automated checkpoint for classification commit b8b7a03: compile passed;
the standard npm test -- --runInBand command exited 0 with 187 suites / 1,455 tests
passing, including snapshot/undo/restore/changelist/virtualization regressions.
Existing ts-jest and process-listener warnings remain visible. The unchanged
rendering-bundle size failure remains unresolved. Plugin runtime 3d1a704 and adapter
probe e4514e6 were used with GUI b8b7a03 in a fresh real-service Node adapter probe;
it passed and the service exited. That probe did not load an Extension Host/Webview.
