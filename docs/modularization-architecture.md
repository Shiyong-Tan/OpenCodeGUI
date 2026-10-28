# OpenCode GUI modularization architecture

Chat selection clipboard actions are owned by the feature controller. Only a
selection wholly within chat and outside editable controls can issue an explicit
copy request. Context-menu actions capture text and session together and expire
on selection-owner changes. The utility boundary validates owner/text bounds and
writes through the VS Code clipboard API; it never reads the clipboard or changes
messages, drafts, focus ownership of other sessions, or paste/image handling.

A native subagent call with an explicit reused sessionID triggers a read-only
identity check through the captured V2 binding. Only a direct child in the same
workspace and current parent turn is registered. The existing child lifecycle
owner reopens finished children; active child state is preserved. The existing
Sidebar progress owner resets terminal display fields for the new invocation.
Parent tool completion reconciles native child terminal evidence. Selection,
permission boundaries and historical card ownership are unchanged.

For OpenCode 2 OpenAI quota reads, the selected V2 transport projects only the
single active OpenAI OAuth account from credential.list into ModelQuotaService.
Secrets remain inside the extension and are never sent to Webview, persisted or
logged. Native absence/failure never falls back to an obsolete host auth.json;
OpenCode retains credential refresh ownership. OpenCode 1 keeps file auth. Only
bounded reason codes, not provider response bodies, enter quota diagnostics.

Finalization reads the explicit canonical assistant record once before chatDone.
OpenCodeClient verifies session/message/turn/service ownership and replaces its
bounded streaming preview with the full final text. The coordinator sends that
same text with the final ID; Webview applies it only after accepting that final,
clearing stale presentation segments. Incremental snapshots read the same owner.
A failed exact read does not promote a temporary preview to authoritative text;
no transcript scan, model request or history rewrite is introduced.

OpenCode 2 changelists obtain their authoritative paths from the native turn-diff
endpoint using explicit root/latest-append user IDs. The transport adapter owns
wire validation; OpenCodeClient owns workspace normalization. No failed read may
fall back to the newest turn or all workspace changes. OpenCode 1 keeps its
message-summary diff path. Both feed the existing Git commit/binding/emitter and
Undo/Restore owners. Restore checks command success and verifies actual files
before publishing success or advancing the session base.

Restored child cards are reviewed by their displayed session identities, separately
from runtime registration. A bounded, read-only request verifies direct parent,
workspace, service binding and native execution outcome. Returned terminal facts
are an ephemeral per-session display projection applied to all owning bubbles;
they never register children or rewrite snapshots. Completion timestamps fence
newer continuations; repeated hydration and stale progress cannot revive old cards.

Switch-back hydration recognizes explicit delivered append IDs on the active root
as parent identities of the same live presentation. It never folds unrelated turns
or infers ownership from matching text. Selection also refreshes only registered
native children with terminal session outcomes; fresh transcript finality and the
existing binding/child guards own terminal transitions. This does not finalize the
parent, enumerate historical descendants, or alter persisted snapshots.

Native interaction discovery treats location-wide lists as hints. It queries the
original session endpoints for the parent, active descendants and previously
pending owners, verifying ancestry before child reads. This restores permission
and question cards after reload without enumerating historical child transcripts.
Original request identity, workspace validation and fresh review tokens still
govern replies; no permission is inferred or auto-approved from Supervisor health.

Inline wait metrics join the panel controller's current authenticated observation
by parent session, child session, execution and task attempt. This is a read-only
display projection, not a second writer of tool execution state. Selection epoch,
connection state and a five-second freshness bound fence reuse. Panel observations
refresh this projection without model calls or extra polling. Tool-only subagent
updates reconcile call-keyed rows locally; text, topology or lifecycle changes
fall back to normal rendering. Timers keep their original deadline and cannot
remove an unrelated parallel tool node.

Process-wait metrics originate in the plugin's owned execution samples and travel
through tool progress metadata to the existing session/message/call-keyed subagent
tool owner. The renderer displays only the bounded summary and does not infer
process health from an ongoing wait or manufacture CPU/runtime data.

Subagent tool completion remains immediate in the canonical owner. The first
terminal transition from a locally observed active call supplies an immutable
settled timestamp; completed-only replay never creates a dwell deadline. Rendering retains
that tool group for two seconds, with a timer scoped only to its captured DOM node.
Replay never extends the deadline and child/parent finality still removes cards.
Collapsed subagent text keeps natural short height with a five-line cap without asynchronous
measure/clamp passes; explicit expansion retains the live full text.

Markdown file URLs and drive paths normalize to inert encoded fragments before
Markdown validation and HTML sanitization. The existing assistant file/image
controller converts those fragments to the local open/resolution protocol after
sanitization. This is shared by both backend families; it does not enable file
navigation, weaken unsafe-scheme filtering, or bypass workspace file checks.

Final snapshot text is resolved by canonical assistant message ID: the client-owned
reconciled text takes precedence over that exact message's delta buffer. A known
message ID must never fall back to the turn-wide stream, which may contain multiple
assistant generations. Missing final text does not prevent persisting the local
user prompt. Existing finalized snapshot records remain immutable; this transition
does not repair historical snapshots by merging remote history.

Question and permission review are separate projections of server-owned pending
requests, keyed by original session and request ID. Reload queries those requests
again rather than restoring actionable cards from chat snapshots. Updated details
replace the same request; settled requests leave the queue. Invalid or foreign-scope
observations block stale decisions, and responses revalidate their review tokens
against the current server state before routing to the original child session.
Native permission requests without a source are valid server-owned interactions:
the native adapter explicitly marks this provenance and the review owner displays
their action, resources and metadata without inventing a tool identity. Legacy
requests and unknown native source variants retain the existing verification gate.

## Dual OpenCode protocol adaptation

V2 bounded history reads start newest-first, retaining enough preceding records to
resolve the selected assistants' user/synthetic anchors before projecting the
chronological suffix. Control records do not consume the visible-message limit;
idle/active execution evidence retains its existing authority. Exact diff and
permission tool lookups use the single-message endpoint, validate its identity,
and never scan the transcript or infer an idle boundary. Full exports remain
complete. Response-bound retries keep the same cursor; page sizes recover only
after sustained small pages to avoid repeatedly downloading large adjacent outputs.

Current native owner integration and validation evidence are recorded in
[OPENCODE-2-COMPATIBILITY.md](OPENCODE-2-COMPATIBILITY.md) and
[OPENCODE-2-WINDOWS-ACCEPTANCE.md](OPENCODE-2-WINDOWS-ACCEPTANCE.md). The foundation
paragraphs below describe earlier checkpoints; they are not the current routing
status. There is still one session/turn owner and no version allowlist.

The runtime release label is diagnostic metadata, not an allowlist. Fixed upstream
versions are reproducible test fixtures only. The first fixture is OpenCode 2.0.24,
tag e7a34f09bfd9134dfade5a8ddb843f7030bc9a69. Existing 1.x behavior remains the
compatibility oracle; a fixture identity alone does not certify every 2.x release.

Implemented foundation on 2026-10-16: BackendSessionPort describes session,
paginated transcript, inbox admission/delivery/cancellation and execution
interruption as distinct operations. V2SessionAdapter implements the native V2
operations through a bounded V2Transport that never retries or changes protocol.
V2Codec preserves native control records, parallel tool identity and unknown record
kinds without deriving finality. V2EventAdapter parses native session/execution/
step/tool/inbox facts without introducing a second state writer. Mutation timeouts,
superseded responses and malformed success acknowledgements remain ambiguous.

The isolated probe script can run --session-contract against an explicitly supplied
V2 native binary: it creates and removes one empty fixture session, reads history
and inbox, and verifies the matching real SSE session-created event. It sends no
prompt, steering or other model-triggering operation. Both V1 identity and V2
session/event fixtures pass; policy/mutation failure scenarios use mocked HTTP.
These adapters are not yet selected by the production GUI. Routing remains V1
until the owner integration, interaction adapters and lifecycle gates below pass.

### Contract and ownership

2026-10-16 continuation: V2ControlAdapter implements native model/agent catalogs,
validated explicit selections, session rename/removal/fork, compaction admission,
and separate staged/cleared/committed revert operations. V2InteractionAdapter
retains permission action/resources and typed form option values, conditional
field visibility, original session ownership and settled state. These ports remain
unselected in the production client. The isolated session fixture additionally
verifies catalog/active reads, rename and form reply without a model request.

Independent subagent tool presentation is production-wired for identity-bearing
ChatEvents. SidebarProvider's existing subagentProgressBySession entry is the sole
owner of its tool collection; updateSubagentTools is a pure transition helper.
The stable key is child session + assistant message + call ID. Terminal updates
cannot regress; all active calls and up to 32 settled calls are retained. The
renderer projects those rows with independent state colors. Legacy events without
call identity retain their existing latest-tool presentation. This change alone
does not enable V2 execution, reconnect hydration or Supervisor V2 loading.

Keep one UI and one session/turn/history implementation. Introduce two transport
adapters behind a narrow domain port: identity/capabilities, session operations,
history, execution events, interactions, compaction, and revert. Version branches
belong only in adapter construction, never in Webview rendering or feature owners.
Do not emulate a V1 endpoint with renamed V2 JSON when their effects differ.

OpenCodeServerController retains connection and process lifecycle ownership. A
protocol binding belongs to that captured service generation and workspace; it
is invalidated by service replacement, authentication changes and workspace
changes. Discovery must not write session state. No process-global adapter cache
may mix windows, profiles, workspaces or credentials.

ProtocolNegotiator recognizes validated identity response shapes using bounded,
authenticated, read-only requests against the selected loopback origin. In the
real 2.0.24 fixture, /global/health returns HTTP 200 HTML, so status and path alone
are not proof of health or protocol. /api/info returns the V2 identity. A 401/403
is an authentication failure, never permission to try other credentials or ports.
Negotiation never sends prompts, creates tasks, installs plugins or restarts a service.

Discovery establishes a protocol candidate, not full feature compatibility. Each
adapter validates its read DTOs and advertises separate capabilities. Unknown
capability is distinct from supported and unsupported. OpenAPI can corroborate a
route, but cannot prove behavior. Unknown extra fields are ignored; missing owner
IDs, unknown terminal states or incompatible critical types fail the affected
operation. Do not coerce unknown state into idle, completed, empty requests or zero
processes. A failed interaction endpoint blocks changes that require verified idle.

### Preserve semantic distinctions

- Prompt admission is not assistant finality. V2 durable inbox identity, delivery
  and execution outcome need distinct domain results; a 200 response cannot
  finalize a turn. Capture IDs before sending and reconcile ambiguous admission
  rather than redispatching with a fresh ID.
- Provider streamed/completed, tool success/failure, step completion and session
  idle/interrupted are different facts. Parallel tool identity is session plus
  assistant-message plus call ID. Never use one global current-tool field.
- Native V2 background subagent completion is not parent completion. Foreground
  and background dispatch are explicit modes, preserving the user's ongoing-work
  contract. Native subagent notifications should have one owner; Supervisor must
  not duplicate them.
- Live events can be missed after disconnection. Reconnect hydrates the owning
  session from authoritative history and active execution, deduplicates by durable
  identity, then resumes live projection. Replayed history is not new progress.
- V2 steering and queued input cannot be silently substituted for V1 append.
  Their acceptance, delivery, canonical message binding and user-visible behavior
  need differential traces before switching the production path.
- Interrupt acknowledgement is distinct from local execution stopped, pending
  inbox cleared and external processes stopped. Unknown native or escaped process
  coverage blocks overlapping recovery.
- Keep snapshots owned by the existing persistence boundary. Backend protocol
  changes do not rewrite saved history, merge unrelated IDs or infer Undo range.
  V2 staged/committed revert needs verified file effects and cannot be replaced by
  one renamed V1 request.
- Compaction is a control operation with its own outcome. Do not convert its
  summary into an assistant answer or silently change the selected/free model.

### Queued append steering

For a verified V2 inbox capability, a pending user item with delivery=queue gets
a compact Steer button immediately beside its Queued label. V1 and capability-
unknown connections do not show an actionable control. The backend's durable
inbox ID is distinct from the optimistic client message ID and must be present.

The command carries captured sessionId, inboxId and service generation. The
Extension rechecks capability and pending ownership, then sends exactly one
PATCH /api/session/:sessionID/inbox/:inboxID with { delivery: "steer" }. It does
not resend the prompt, create a replacement message, or abort a running tool.
Steering takes effect at a safe execution boundary, not immediate interruption.

While submitting, disable the owning button and show Steer pending. Backend
confirmation changes only delivery to steer; do not mark the message seen/applied
until delivery evidence arrives. On an ambiguous timeout, refresh this inbox item
instead of blindly retrying the mutation. A conflict caused by concurrent delivery
refreshes authoritative state and removes the obsolete button without resending.

Reload and session switching derive button availability from the owning session's
fresh inbox projection; an old DOM node or cached Queued label cannot authorize
an operation. Tests must include rapid double click, two queued messages, delivery
racing with the click, timeout reconciliation, switching A/B while PATCH is pending,
service replacement, reload, unsupported capability and unchanged V1 behavior.

### Supervisor packaging boundary

Share supervision policy and process tracking, but keep separate V1 and V2 plugin
entrypoints: their loader, registration, permission and interruption contracts are
different. Never import both SDK runtimes merely to choose one after loading.
Release assets must advertise protocol family and checksum. GUI selects the asset
for the verified backend, preserves custom sources, and leaves configuration
unchanged when the matching asset is unavailable. One package-owned version feeds
lease, handshake and snapshot; automated release tests compare all three.

### Additional V2 acceptance coverage

The protocol audit on 2026-10-16 identified these required adaptations beyond
endpoint discovery, the Steer button and a parallel-tool list:

- Native V2 prompt delivery defaults to steer. The ordinary Append-to-Queued UI
  must explicitly submit delivery=queue. The Steer button changes that same inbox
  item; it does not create a second user message.
- Keep inbox admission, delivery, cancellation and assistant processing separate.
  Existing V1 finalized-append normalization must not mark a V2 queued item applied
  merely because it has a canonical ID or the parent assistant finalized.
- Stop/interrupt and cancel queued input are distinct commands. Interruption does
  not erase pending input. Reconnect must show retained queued items so a future
  resume cannot silently execute work the user thought was discarded.
- Render typed history entries: assistant, user, synthetic, shell, compaction,
  idle, model/agent selection and location changes. Only appropriate transcript
  content becomes a chat bubble; control records still participate in identity and
  lifecycle. Preserve order/cursors across message pages and snapshot boundaries.
- Distinguish provider streamed, tool settled, step ended and execution terminal.
  One assistant may have several concurrent tool calls; do not total tokens/cost
  repeatedly when the same message is hydrated or its tool metadata changes.
- Pending forms are richer than V1 questions: typed number/integer/boolean fields,
  multiselect values versus labels, conditional visibility, required/hidden fields,
  constraints and external links. Reuse the card appearance, not the old answer
  serialization. Non-session/global form ownership must never be assigned to the
  selected chat session. Do not auto-answer hidden/unknown fields by guessing.
- Model and agent selections have session operations and persisted history. Bind
  the intended selection to its queued request and define later selection changes
  explicitly; never silently replace a missing model with a default/paid model.
- Prompt files, agent mentions and skills use typed attachments. Preserve URIs,
  display names, selection context, identity and failed-send drafts; do not flatten
  every attachment into user text or conflate a file URI with an HTTP URL.
- SSE is server-wide and location-bearing. Validate workspace/location plus session
  ancestry and service generation before routing background events or interactions.
  Moving/reloading a location invalidates its capabilities and subscriptions, not
  the canonical IDs or a different location's session state.
- V2 location.reload rebuilds all loaded locations and cancels pending permission/
  form requests. It is not a harmless single-project settings refresh. Supervisor
  installation/reload must use the existing activity/ownership checks and recover
  interaction state; it must not invoke this operation as an automatic workaround.
- Process restart may resume claimed native execution. Old durable execution/tool
  records remain historical, never a license to redispatch the same side effect.
  Native child completion notifications, foreground joins and Supervisor monitoring
  must not create competing completion owners.
- Platform CLI wrappers, service PID/listener ownership, generated passwords,
  plugin config/agent rule formats, upgrade/downgrade and matching release assets
  require separate tests. Do not migrate global agent rules or user data implicitly.

### Delivery gates

1. Freeze V1 tests and reproduce both identities with isolated, credential-free
   profiles. Add false-success HTML, newer release labels, authentication, timeout,
   stale-generation and malformed-response tests. No production routing change.
2. Implement typed V2 session/history/event port and differential send/stream/final,
   parallel-tool, error and interruption traces. Verify A/B/C interleavings,
   duplicate events, delayed final and reconnect without model calls.
3. Adapt permissions/forms, compaction, append and revert individually. Unsupported
   operations must report capability errors without sending a mutation. Side-effect
   timeouts never trigger a protocol fallback or blind retry.
4. Adapt Supervisor's V2 plugin entrypoint and release asset selection. Test native
   foreground/background children, stall decisions, stop evidence and partial work.
5. Run V1 and V2 contract suites, original regression gates, real isolated server
   fixtures and the manual UI matrix before enabling V2 in a release installer.
   A passing identity probe alone is never advertised as full compatibility.

Model-call acceptance remains separate and requires explicit authorization. During
development, do not change global configuration, user databases, ordinary services,
GUI release number or existing plugin installation. Work remains local unless
publication is explicitly requested.

This document describes the ownership boundaries on `refactor/modularize-large-files`.
The entry files remain compatibility/composition surfaces; extracted modules must not
create a second writer for their host state.

## Extension ownership

| Capability | Module owner | Entry responsibility |
| --- | --- | --- |
| Models, variants, quota | `src/models/ModelQuotaService.ts` | Construct service and forward results |
| OpenCode process and transport | `src/transport/*` | Supply workspace/configuration and lifecycle callbacks |
| Server-event interpretation | `src/events/OpenCodeEventMapper.ts` | `OpenCodeClient` retains lifecycle stores; mapper preserves event/side-effect order |
| Webview chat-event adaptation | `src/events/SidebarChatEventHandler.ts` | `SidebarProvider` retains session and finalization state |
| Webview command protocol | `src/webview/SidebarWebviewController.ts` | Required VS Code provider method delegates once |
| File changes and diff | `src/changes/*` | Compose persistence, extraction, emission and viewer services |
| Snapshot persistence and delta proof | `src/history/SnapshotStore.ts`, `SnapshotDeltaPlanner.ts` | Choose the active session and provide canonical records |
| Snapshot-first initialization | `src/history/SidebarSessionInitializer.ts` | Own handshake lifetime and pass the current Webview identity |
| Continuation and finalization | `src/continuation/*` | `OpenCodeClient` owns turn maps; coordinators resolve identity and freshness |
| Undo/restore | `src/undo/*` | Route explicit session/operation identity and publish verified results |

The large event/controller adapters receive their owning entry instance as an explicit
compatibility host. This is intentional: moving the implementation must not move the
canonical Maps, timers or VS Code lifetime objects. Contract tests freeze the one-hop
delegation and representative ordering behavior.

### Sidebar command-family composition

`SidebarProvider` is the sole composition root for the Sidebar command protocol. It
constructs the Utility, Session, Turn, Undo, and Lifecycle controllers once, binding
each controller to its own narrow family host. The provider then supplies
`SidebarWebviewController` with a pre-bound `SidebarWebviewDependencies` object; the
dispatcher never receives the provider itself and does not receive a host argument
when handling an individual message.

| Command family | Controller and bounded host | State ownership |
| --- | --- | --- |
| Utility/search/model/file/interaction | `UtilityCommandController`, `UtilityCommandHost` | Provider domain methods own model, mode, search, attachment, file and interaction effects |
| Session | `SessionCommandController`, `SessionCommandHost` | Provider domain methods own selection, creation, deletion, history loading and snapshot-timeline state |
| Turn | `TurnCommandController`, `TurnCommandHost` | Provider domain methods and continuation owners retain per-session turn, append and cancellation state |
| Undo/Restore | `UndoCommandController`, `UndoCommandHost` | Provider and `src/undo/*` domain methods own operation identity, canonical ranges, segment state and verified file restoration |
| Lifecycle/liveness | `WebviewLifecycleController`, `WebviewLifecycleHost` | Provider lifecycle methods own panel identity, handshake, rescue, timers, visibility and disposal |

`SidebarWebviewController` is consequently a narrow protocol edge. It configures the
Webview, registers message/visibility/disposal listeners once, parses and logs inbound
messages, and routes each message through the pre-bound family handlers in a fixed
order. It owns no cross-family registries and does not compose the family hosts into a
larger interface. Domain state remains behind provider-owned methods, so extraction
changes call location without creating a second writer.

## Webview ownership

| State or behavior | Module owner |
| --- | --- |
| Model selection | `webview-src/features/models/*` |
| Composer attachments/context/input | `webview-src/features/composer/*` |
| Header state and rendering | `webview-src/features/header/*` |
| Normal and Smart Search state/navigation | `webview-src/features/search/*` |
| Changelist rendering/events | `webview-src/features/change-list/*` |
| Segment topology | `webview-src/features/segments/segment-topology.ts` |
| Undo request construction | `webview-src/undo/undo-request-controller.ts` |
| Session store and hydration flags | `webview-src/continuation/session-store.ts`, `hydration-state-controller.ts` |
| Cross-session routing | `webview-src/continuation/session-event-router.ts` |
| Metadata render coalescing | `webview-src/continuation/session-render-scheduler.ts` |
| Append snapshot lifecycle | `webview-src/continuation/append-snapshot-controller.ts` |
| Message DOM rendering | `webview-src/rendering/message-renderer.ts` |
| Virtual window and scroll policy | `webview-src/rendering/*` |

Virtualization owns only the mounted DOM window, measurements, anchors and spacers.
It does not own messages, segments, changelists, hidden state or active turns. The
message renderer receives live getters from `media/main.js`, preventing session or
undo state from being captured at module initialization.

### Message renderer capability boundary

`webview-src/rendering/message-renderer.ts` receives a bounded
`MessageRendererHost`, not the global Webview object. The ordinary-JavaScript
`media/main.js` facade supplies live read-only capability getters for the
renderer's message, session, segment, append, undo, DOM, and presentation
needs. Renderer dependencies are type-checked in TypeScript and the real
facade shape is covered by a runtime contract.

The renderer records a message ID only after its root is accepted by the
append capability; rejected, missing, thrown, and early-return paths remain
retryable. Segment-toggle and undo rerenders use the explicit
`requestRerender` capability, and duplicate-render warnings use the explicit
`logWarning` capability. The renderer does not access the global rerender
backchannel or `console` directly.

This boundary does not alter virtual transaction/coordinator ownership:
`media/main.js` remains the owner of virtual reconciliation, measurements,
scroll anchors, safe-shell behavior, and recovery/prepare-commit-abort logic.

### Wave 2 planner and identity boundaries

Wave 2 moved pure decisions to the changelist materialization, append root/status,
segment topology, and hydration integration planners. The append planner is limited
to selecting an append root and resolving monotonic append item status, including
update-winning duplicate collapse. It does not own acknowledgment binding, alias-map
writes, or general identity migration.

Broad local/tmp/server identity rekey remains in `media/main.js`, including
`handleUserAckBindMessage`, `replaceKeyEverywhere`, and
`rekeyKeyedChatPresentation`. That compatibility path still coordinates identity
across messages, timelines, segments, Undo, turns, search, subagents, append state and
presentation. Its keyed presentation roots and the virtual transaction, measurement,
anchor, safe-shell, recovery, and prepare/commit/abort coordinators remain frozen.

## Critical invariants

- Snapshot data is applied first. Only a proven newer suffix may be appended; an
  unproven boundary remains non-authoritative until the full-repair path proves it.
- A fork snapshot starts at the child branch boundary. Parent history remains in the
  OpenCode backend context but is neither rendered nor duplicated in the child
  snapshot; fork-origin metadata provides navigation back to the parent session.
- Export failure does not disable snapshot persistence for subsequent local events.
- Background-session events update that session's store and never mutate the current
  session DOM.
- Changelists retain their canonical message anchor and timeline order.
- Undo/restore routes explicit session, operation and canonical message ranges; UI
  visibility cannot replace the Extension's more complete range.
- Restore success represents both message restoration and verified workspace/Git
  restoration. Conflict ownership must match before retrying.
- Nested segment expansion preserves canonical order and never appends nested members
  to the end of the chat.

## Validation and manual UI checklist

Automated gates are Jest, extension TypeScript compilation, deterministic Webview
bundles, bundle size checks and VSIX content policy. After merging or rebasing, manually
verify:

1. Reload a long session: snapshot content appears in the same order, the proven newer
   suffix follows it, and `Loading history ...` disappears.
2. Switch between a streaming and an idle session: no render oscillation; returning to
   the streaming session shows its current turn.
3. Search a long session, navigate matches, then drag the scrollbar quickly and jump to
   the bottom; the Webview remains populated.
4. Undo a range containing changelists and nested segments, expand it, restore it, and
   verify both message order and real files.
5. Confirm code-block Copy, attachment send, Smart Search temporary-session cleanup,
   new-session blank state and changelist anchoring.

## Remaining compatibility surface

`media/main.js` still contains the tightly coupled safe-shell and transactional virtual
reconciliation coordinators. They stay in place because their source-shape and mutation
tests protect gray-screen recovery and anchor correctness, and the rendering bundle is
already close to its enforced size ceiling. Future extraction should use a separate
presentation bundle and live host getters, one renderer at a time, with the same full
regression gates.

A pure render projector/route classifier and an `EventEffect` representation are
future evaluations only. They are not part of the accepted command-family extraction;
either requires a separate reviewed plan and evidence that it simplifies ownership
without duplicating state or disturbing side-effect order.

## Phase 5 explicit Windows service ownership

OpenCodeServerController remains the only service-operation owner. Its existing
OpenCodeServerProcess composes a short-lived WindowsServiceJob OS adapter. Signed,
immutable OpenCodeServiceRecordStore generations are persistence of that owner,
not an independent service manager. Commands only delegate to the controller.

Ownership requires the private profile signature, canonical workspace, service
authentication binding, random Job identity, PID plus OS creation FILETIME, Job
membership and a loopback listener belonging to that Job. An old PID, port or lock
file alone never authorizes stopping. External and legacy unregistered services
remain usable for ordinary chat but are not adopted or stopped.

GUI reload/exit, workspace detach and supervisor disable retain the service.
Start/Stop/Restart Service commands serialize through the existing controller
queue and an OS workspace mutex. Active or permission-waiting execution requires
an impact confirmation (15-second deadline); unknown activity fails closed.
Only proven root exit and zero Job members allow a replacement. Requests target
the captured generation; duplicate operations share work and stale requests fail.
Unknown launch/stop outcomes retain immutable records for diagnosis. No process
name discovery, second service manager or automatic redispatch is introduced.

NormalSupervisorIntegration rechecks launch generation after a live read, including
restarts from another window. Durable notification classification is retained
independently of live authentication. Session, snapshot, final, append, undo and
rendering owners and their contracts do not change.

### Turn completion and send rejection

Quota refresh is ancillary work scheduled only after the owning turn-command lock
has been released. It cannot hold finalization open or turn a completed chat into
an error. ModelQuotaService bounds each default HTTP request to 10 seconds.

SessionComposerStore owns the composer recovery snapshot for an in-transit send,
addressed by sessionId, clientMessageId, opId and tmpKey. sendAccepted releases that
snapshot; sendRejected consumes it once and restores it alongside newer composer
content. The Webview removes only that rejected pair of temporary message IDs;
it does not finish or cancel the backend's existing turn. Stale responses cannot
restore an accepted or superseded submission. No rejected send is retried automatically.

### Compaction-only idle outcome

CompactionOutcome classifies server records without changing message identity or
history. OpenCodeClient owns verification for the captured TurnState and current
user ID: on idle without a real assistant, read recent messages, confirm idle,
and read again. Only a completed summary attached to the same ordinary prompt,
with no subsequent user/control prompt or non-summary assistant, can produce a
terminal error. Cancellation, replacement turns and a newly bound assistant
invalidate the check. The existing error/finalization path releases the request;
the summary never becomes a canonical answer, and no prompt is automatically sent.
Manual compaction compares before/after summary identities to distinguish provider
failure from a verified new completed summary, regardless of HTTP success.

2026-10-16: Native dual-protocol integration is documented in
[OPENCODE-2-COMPATIBILITY.md](OPENCODE-2-COMPATIBILITY.md). Protocol bindings own
transport generations only; OpenCodeClient and the existing session owners retain
history, finality and UI mutation authority. Native controls and typed interactions
do not create a second lifecycle pipeline.
