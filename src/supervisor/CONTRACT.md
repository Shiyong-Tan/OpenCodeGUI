# Confirmed supervisor follow-up contract — 2026-09-19

## Phase 5 normal-install trial delivery — 2026-09-24

Normal installation and explicit service control are implemented. The existing
controller/process owners retain authority; signed immutable ownership generations
plus OS Job, creation-time and listener membership authorize control across reload.
Start/Stop/Restart are command-palette entries. Active execution requires impact
consent; unknown identity/activity/stop result fails closed. GUI close, reload,
workspace detach and supervisor disable preserve the service. No second manager
or automatic redispatch exists.

Runtime commits: 40ea86e native owner; 5f453ab durable generations; 73c2f9f bounded
operations; c80fd0a command composition; cc28c6b stale-read fencing. Existing message,
snapshot, append, final, timing and session ownership contracts are unchanged.
Historical notification classification remains independent of live connectivity.

201 suites / 1555 tests, compile, original bundle limits and determinism passed.
Actual ordinary installed VSIX checks cover service commands, reload/close survival,
default-off, missing plugin, invalid signed lease and external-service refusal.
The completed real model loop was recovered in a new GUI process and survived
service restart, reload and disable with exact final IDs/order/provenance and 10s/5s
clocks. Active consent was exercised using a real bounded no-model shell and VS
Code custom dialog. The failed native-dialog DOM probe is preserved; it is not a
pass. No Development Host or Node reader probe substitutes for these GUI checks.

Phase 5 is a nonimportant-workspace trial only; model ledger 16/24, Phase 4 42/42
unchanged. See [trial operations](../../docs/PHASE5-TRIAL.md) and the companion
supervisor repository's PHASE5-RESULTS.md/phase5-current-commit-map.json for artifact
hashes, exact evidence, limitations and compatibility mapping. Stop at user review;
no promotion to important sessions or long-term stability claim.

The following Phase 5 entries are historical checkpoints superseded by this section.

## Phase 5 normal-install integration — implementation started 2026-09-24

The user explicitly authorized Phase 5 after Phase 4 acceptance. The completed
Phase 4 evidence and 42/42 budget below remain unchanged; this is not new GUI or
model acceptance. Normal-install enable/disable is still unfinished.

The existing OpenCodeServerController and OpenCodeServerProcess remain the only
service launch owners. An optional, two-second-bounded preparation callback may
provide private supervisor metadata only for a real owned spawn. Reuse never calls
it; failure falls back to ordinary service startup with a fixed, redacted diagnostic.
The process owner explicitly clears inherited supervisor binding metadata unless
that specific launch supplies it. No new service manager, discovery scan or restart
action is introduced. The callback is wired through workspace-scoped SecretStorage and the default-off opencode.supervisor.enabled setting.

Normal connection discovery will use a separate authenticated protocol, not removal
of experimental descriptor checks. Live supervision and durable notification
classification must be separated: disabling polling cannot expose previously trusted
internal messages or erase provenance. Existing actor, final, snapshot, append,
timing and session isolation owners retain authority. No rendering size limits or
private-property mangling boundaries change.

Focused startup tests cover reuse without metadata work, successful preparation,
failure redaction, timeout with a controlled clock, and inherited-binding rejection.
Ordinary installed VSIX/Webview enable, disable, new GUI process, reload and completed-history recovery passed in private profiles. The Phase 5 model run used 8/24 newly authorized requests and verified actual parent result reading and one independent follow-up. This does not establish service-restart/fault acceptance or service process exit; those remain pending. No production-ready claim, deployment, automatic cancellation or redispatch. Exact evidence is in the companion supervisor repository docs/PHASE5-RESULTS.md.

### Confirmed GUI/service lifetime — 2026-09-24

The user chose to preserve services across GUI close/reload. Extension disposal must stop local polling/subscriptions and drain existing persistence without killing a service. Explicit start/stop/restart operations must remain in the existing transport owner and authenticate ownership; process-name matching and adopting unrelated services remain forbidden. These operations and restart acceptance are still pending.

## Final Phase 4 acceptance — 2026-09-23

Phase 4 is complete within the isolated development experiment. Stop for user review;
no Phase 5, deployment, push, automatic cancellation, persistent takeover or redispatch.
Webview presentation, trusted identity classification, independent follow-up lifecycle,
active recovery and completed-history recovery are implemented and actually verified.
Earlier incomplete/pending statements below are chronological checkpoints, superseded
by this section, not current blockers.

- GUI wiring: 331968a; tool-only recovery: fb8003f; selection/epoch/terminal recovery:
  8ec16b9; production size-gate closure: 2d90d32.
- OpenCodeTaskSupervisor evidence/scripts/report: e5f67a1; plugin runtime projection:
  1ebaba2. Exact repository mapping is in its docs/evidence/phase4-current-commit-map.json.
- Full final GUI regression: 193 suites / 1,501 tests; compile, all original Webview
  size limits, deterministic build and VSIX content checks pass. Plugin 74 tests pass.
- Actual isolated B/C/G/H and R cover the plugin → Extension Host → Webview chain.
  R uses a labelled setup hook, but actual models produce the child result and choose
  the parent result tool. Its active process restart preserves the source round/start;
  later no-model GUI checks verify the authoritative final-ID handoff and exact
  switch/restart history with original 4s/35s clocks. No Node adapter probe is counted
  as GUI acceptance. B/C retain autonomous dispatch/closed-loop proof.
- Final compacted production Webview was rerun against actual H history/PNG/scroll
  and R final history/clock/restart, without a model. Earlier failures are retained.
  The final actor terminal recheck and compaction were not another paid model rerun.
- Ledger: 42/42, preserving prior usage after authorized extensions. All experiment
  services/windows exited. OAuth was read-only; no credentials, database or profile
  is committed. No-model recovery deliberately disables all providers.

Production compaction preserves getters/public keys and checks its private-field
boundary. Rendering is 76,784/76,800 bytes (only 16 bytes of raw headroom), continuation
51,695/52,224. Limits were not raised. See [build boundary](../../docs/production-bundle-compaction.md).
Only Windows, OpenCode 1.18.29, and isolated VS Code 1.137.0 are validated. This does
not establish production readiness, arbitrary tools or recovery from a hung core.

## Active selection recovery checkpoint — 2026-09-23

Recent/full history selection now invokes the same busy-turn recovery owner as
initialization, after sessionData publication. The selected session and epoch are
captured before status lookup; terminal round metadata is checked again inside the
session actor. Tool-only activity is transient and cannot rewrite finalized history.

Real GUI scenario R restored the same active round after a complete process restart,
with the original observed start and old WAITING final unchanged. A real parent model
then selected supervisor_result and read READY. Setup used an explicitly labelled
registration/dispatch hook, so R is GUI recovery proof, not autonomous dispatch proof
(B/C retain that evidence). Four requests brought the cumulative ledger to 42/42.
A zero-model restart then checked the authoritative final message ID handoff and
exact final history across switching and another process restart (4s/35s unchanged).
The first final-history comparison was sampled before the GUI finalization buffer;
its failure is retained and the runner now waits for actual GUI finalization.

Full regression: 192 suites / 1,498 tests pass. The size gates below still need closure;
this is not an assertion that all repository gates pass. No Phase 5 or production use.

## Earlier acceptance status — 2026-09-23

The plugin/Extension/Webview wiring and independent-round presentation are implemented.
Phase 4 is still incomplete: actual active restart D failed, its tool-only recovery fix
fb8003f passes 192 suites / 1,488 tests and compilation, but the real model rerun
is pending. C completed-history recovery passed a fresh GUI process and new plugin
instance. H subsequently passed actual pagination, image decode, scroll anchoring and
fresh-process history restoration with 182 backend messages (bulk text explicitly
seeded with noReply). B/C/G model/GUI runs passed on 331968a. No Phase 5 work.

Cross-repository evidence/scripts: OpenCodeTaskSupervisor 8067c9e; runtime projection
1ebaba2; GUI runtime 331968a then tool-only repair fb8003f. Evidence is under that
repository's docs/evidence/phase4-gui-model. These are actual VS Code 1.137.0 and
OpenCode 1.18.29 executions, separate from the earlier Node adapter probes.

The request ledger is 31/36 after explicit user extension; another increase is not
authorized yet. Rendering and continuation size gates remain failed as detailed
below; supervisor size, deterministic builds and VSIX content policy pass.
Everything below is the historical decision/checkpoint record unless superseded here.

The user selected an independent follow-up turn. Preserve the previous reply,
final identity, elapsed time and persisted history exactly.

After the parent is terminal, a new execution triggered by trusted supervisor
notifications starts an independent turn labelled “Supervisor notification”, associated with
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

The installed VS Code launch failed on its vscode-updating mutex; that evidence
is retained. On 2026-09-21 an official standalone ZIP of VS Code 1.137.0, with a
fresh isolated profile/extensions/home and explicit development extension, entered
the real workbench and loaded this Webview. Ordinary history-list clicks selected
parent A, B, then A; the panel showed A's task only in A and the same plugin instance
throughout. The window exited normally and the isolated service was cleaned up.
No existing VS Code window or updater process was modified.

This actual no-model UI checkpoint uses GUI 3f2b72e and plugin runtime 3d1a704.
Evidence and screenshot: OpenCodeTaskSupervisor/docs/evidence/
phase4-actual-webview-no-model.{json,png}. Registration/disposal used a documented
test hook; no model requests or OAuth reads occurred. The first attempt did not
select parent A and failed as expected; its evidence is retained separately.
This proves the read-only Extension-to-Webview chain, not independent follow-up
lifecycle or full A–H acceptance. Phase 4 remains incomplete.

Final automated checkpoint for classification commit b8b7a03: compile passed;
the standard npm test -- --runInBand command exited 0 with 187 suites / 1,455 tests
passing, including snapshot/undo/restore/changelist/virtualization regressions.
Existing ts-jest and process-listener warnings remain visible. The unchanged
rendering-bundle size failure remains unresolved. Plugin runtime 3d1a704 and adapter
probe e4514e6 were used with GUI b8b7a03 in a fresh real-service Node adapter probe;
it passed and the service exited. That probe did not load an Extension Host/Webview.

## Existing actor queue prerequisite (2026-09-21)

SessionActor.runSerialized / ChatEventActorRouter.runSerialized now allow an
internal follow-up operation to wait behind prior finalization effects using the
same existing queue. Such an operation does not advance event sequence, mutate
the turn reducer or create a user message. It must not await re-entry into its own
queue. Errors reject its caller while later events can continue; disposal fences
callbacks. Fifteen actor/router tests and TypeScript checking pass, including a
pending old snapshot with independent session B progress. This prerequisite alone
does not implement follow-up creation, durable timing, rendering or GUI acceptance.

## Durable provenance owner (2026-09-22, not yet connected to live lifecycle)

SupervisorRoundStore owns only notification/assistant/execution associations and
first-observed activity timing. Existing session actors remain lifecycle owners;
all mutations must run in their queue after previous finalization effects. It
persists before publishing new provenance, preserves ended records, associates
multiple notices with one explicit execution, and records an already-active
parent as an existing-turn association rather than creating a new generation.

Nine focused tests cover deduplication, late events, concurrent parent isolation,
reload equivalence, persistence failure, conflicting/foreign records, and an
unfinished ledger with a terminal host. The last case is unresolved, not permission
to invent or resume a generation; live history reconciliation must resolve it.
These are storage-contract tests using a controlled in-memory storage implementation,
not filesystem durability or GUI acceptance. Live activity classification, storage
binding, Webview round creation/labels, queue timing and full A–H remain unfinished.

Actual no-model GUI evidence mapping: supervisor probe commit 51d86ec, GUI runtime
3f2b72e (documentation 39a01b3), plugin runtime 3d1a704. No model requests have been
made in Phase 4; the authorized budget remains 0/24.

## Actual bridge-disconnection checkpoint (2026-09-22)

Supervisor probe aacd9e8 extends the actual GUI check while the window stays open:
a launcher-created no-model hook disposes the real plugin bridge, and the Webview
must retain task identity with an explicit historical/unknown label and no live
label. Fresh lab readonly-probe-qUos4P passed; the window exited with code 0, the
descriptor disappeared and the service exited. JSON and screenshot are in
OpenCodeTaskSupervisor/docs/evidence/phase4-actual-webview-disconnection.{json,png}.
This covers F's bridge-disconnection path and read-only A/B selection, not model
A–C, full lifecycle D/E, ordinary-mode G or long-history/image H. No Phase 4
completion is claimed. Provenance source module d16d361 remains unconnected;
the runtime Webview bundle for this check is the previously compiled 3f2b72e.

## Assistant activity evidence prerequisite (2026-09-22)

SupervisorAssistantObserver correlates assistant parentID with the exact trusted
notification lookup. Metadata, status polls and empty parts produce no activity;
nonempty text/reasoning and tool-state parts do. Full-part duplicates are hashed
and suppressed. Delta events have no stable event ID, so no per-delta deduplication
is claimed; the round owner must deduplicate round creation. Cross-session or
reassigned identities fail closed, disposal fences pending lookups, and caches
have fixed capacities. It does not modify progress clocks or lifecycle state.

Seven observer tests plus nine round-store tests pass. These are unit contracts,
not live observer wiring or GUI round acceptance. The observer and provenance
store remain prerequisites; current terminal guards have not been bypassed.

## Live round wiring checkpoint (2026-09-22, model GUI validation pending)

The classified SSE lane now captures observation time before asynchronous lookup,
correlates real assistant activity and enters the existing session actor queue.
SupervisorRoundCoordinator connects provenance to the isolated development host's
Memento storage (keys include isolation and session). It persists before calling
the existing startTurn boundary, never registers an internal display-user/append,
and attaches accepted final successor IDs before snapshot projection. Retired
source metadata is fenced as well as content events.

Webview supervisorRoundStarted uses the existing lifecycle controller and shared
start-presentation reset; normal prompts retain their existing behavior. The
canonical message renderer shows a source label from message metadata. Duplicate
starts and finalized records cannot create a generation. Existing snapshots are
not rewritten to hide notifications. Queue wait and submission-to-first-observed
activity are separately projected by the plugin; neither is model execution time.

Compile and the fixed-source full suite passed: 191 suites / 1,482 tests. Plugin
queue timing tests total 72 passing. First broad regression exposed two source
harnesses needing the shared reset function; their existing behavioral assertions
were retained. One in-flight run also saw mixed test/source versions during edits;
the subsequent fixed-source run passed. Rendering remains over its unchanged
75 KiB cap (now includes the provenance label); no threshold was increased.

Active reload with an unfinished durable record still requires authoritative
history reconciliation; it remains fail-closed rather than reopening a terminal
host. Model GUI A-C, complete D/E, ordinary mode G and long-history H remain pending.
No claim of Phase 4 completion. OAuth was read-only checked for validity under the
current authorization; no credential was displayed/changed and requests remain 0/24.

## Actual model GUI checkpoint (2026-09-22)

The live wiring above passed actual isolated VS Code 1.137.0 / OpenCode 1.18.29
model runs B and C, using openai/gpt-5.5 and 18/24 cumulative requests. B proved
child completion during a busy parent, queued delivery and model-selected result
reading/follow-up. C proved managed-stop evidence/artifact reading and the explicit
stop_and_review decision. Both displayed one independent labelled assistant and no
internal user/append bubble, preserving the previous final identity and text.
C also passed real history-list switch-away/back and workbench reload, comparing
all visible canonical IDs, order, labels and text. Both owned windows/services exited.
Evidence lives in OpenCodeTaskSupervisor/.lab/gui-model-PsQiHG and gui-model-yayr7s.

Active history recovery now reuses the existing busy-session recovery boundary,
restores the durable execution ID and first-observed start, and resumes the same
partial assistant. It does not rewrite snapshots or invent activity when idle.
Focused recovery validation passed 11 suites / 66 tests plus compilation. Actual
active-reload, ordinary-mode and long-history checks remain pending; Phase 4 is
not yet complete. Earlier unconnected/0-request checkpoints above are historical.

## Tool-only active recovery regression (2026-09-23)

Real run D (gui-model-C1eEbv) failed after an actual GUI process restart while
the parent was still busy: history formatting omitted the assistant that had
only tool activity. This is a failed GUI acceptance case, not a completed phase.
SupervisorHistoryRecovery now projects a transient recovery candidate only from
actual parts, the exact trusted notice parent and an unfinished durable round.
The existing busy-session owner restores it after snapshot hydration; the candidate
is never inserted into finalized snapshot history. The Webview restores one
transient thinking presentation with the original observed clock. Newer users,
foreign sessions, metadata-only placeholders and completed rounds are rejected.
Focused validation: 11 suites / 66 tests plus full compile passed. Real model
revalidation is pending. Budget is 31/36; any further extension requires approval.

The final C history was independently reopened in a fresh GUI process and a new
plugin instance with the same isolated profile/storage; all canonical IDs/order/
labels/text and visible 10s/8s clocks survived. This stronger evidence supersedes
the earlier browser-reload screenshot, which did not visibly show the sidebar.
Normal mode G passed actual chat/append/manual stop. H image-history checks remain
in progress. Full prior fixed-source Jest: 191 suites / 1,485 tests. VSIX contents
and deterministic build pass. Rendering is 82,304 bytes / 75 KiB; continuation is
55,688 bytes / 51 KiB (its source/limit unchanged from baseline 5da2132). Both size
failures are retained; limits are not raised. Phase 4 remains incomplete.
# Task card presentation

The read-only overlay presents a bounded optional task `title`, not canonical IDs.
Older snapshots without this additive field remain accepted as untitled tasks.
The plugin registry still owns task identity and status; the title is presentation
only. Prompts, commands and output remain excluded from the snapshot projection.
Titles are inserted with textContent and never interpreted as markup.

Cards retain DOM identity by instance/task/attempt, preserving diagnostics expansion
and scroll position through polling. IDs, versions, process evidence and notification
details remain available in closed Diagnostics sections. Previous-instance evidence
is closed by default. Unavailable/invalid observations retain evidence with an unknown
status, never a fresh success color. Connection alone does not restore live status.
Session selection clears only this overlay's projection. Chat/history ownership,
finality and recovery behavior remain unchanged.

Status colors supplement English labels: running blue, completed green, attention
amber, failure/unreachable red, unknown/historical neutral. Rounded translucent
surfaces use theme variables, keyboard focus outlines and forced-color fallbacks.
The supervisor-only bundle budget is 18 KiB minified / 7 KiB gzip to include this
keyed renderer and scoped styles; other bundle budgets are unchanged. GUI stays 5.0.7.

Validation: 201 Jest suites / 1576 tests passed, including literal-title rendering,
legacy/invalid titles, hidden diagnostics, retained card nodes/expanded details and
scroll, session isolation, instance changes and stale status colors. Compile, bundle
checks and determinism passed (supervisor: 17,287 bytes / 6,188 gzip). The actual bundle
was visually checked in isolated headless Edge using static fixtures in dark/light
themes and a 320px frame. This is not a live-service or paid-model test. The 5.0.7
VSIX manifest and included bundle were verified; no daily service was restarted.
