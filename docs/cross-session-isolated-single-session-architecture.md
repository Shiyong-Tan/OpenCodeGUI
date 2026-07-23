# Cross-session isolated single-session architecture

## 1. Status and authority

This is the authoritative v2 design for cross-session execution and rendering.
It supersedes the proposed runtime architecture in
`cross-session-turn-runtime-architecture.md`, while retaining that document as
the root-cause record.

The design is based on the user-approved product rule:

> Every session behaves exactly like the currently correct single-session UI.
> Cross-session support only allows independent instances of that same
> behavior to run concurrently and allows the user to choose which instance is
> visible.

This rule has higher design priority than introducing a new turn model,
rewriting append semantics, or making cross-session-specific presentation
decisions.

## 2. Product requirements

### 2.1 Single-session equivalence

For any session, the observable result of processing its events alone must be
identical to processing those same events while events from other sessions are
interleaved.

Observable result includes:

- messages, text, status, tools, todos, and subagents;
- assistant temporary-to-canonical binding and final state;
- append prompt ordering, status, and presentation;
- changelist ownership and placement;
- undo/restore segment topology and real file behavior;
- snapshot/history state;
- composer state;
- search anchors;
- render ordering and virtualized presentation.

Cross-session code must not redefine any of these behaviors.

### 2.2 Session independence

- A and B own independent state and independent active turns.
- A active does not prevent idle B from starting a turn.
- A and B may run turns concurrently.
- An event owned by A cannot read, mutate, render, scroll, finalize, snapshot,
  or clean B.
- A command captures its target session before the first asynchronous
  boundary. Later work never re-reads the visible session as ownership.

### 2.3 Session selection

- Selecting a session changes only the visible session.
- Selection does not reset, hydrate, pause, cancel, resume, or finalize any
  session.
- Background events update their owning session without touching the visible
  DOM.
- Selecting a session renders its latest in-memory state immediately.
- Selecting a session automatically scrolls that session to the bottom.
- Older asynchronous selection/hydration responses cannot override the newest
  user selection.

### 2.4 Turn authority

- Main-assistant lifecycle is the authority for the session turn.
- When the main assistant is final, the turn is final.
- Subagents are expected to be terminal by main-assistant finalization.
- A late subagent event cannot move a finalized main turn back to active.
- A finalized assistant cannot become temporary, thinking, streaming, or
  finalizing after hydration, reload, or delayed events.

### 2.5 Existing feature compatibility

Append, subagent, changelist, undo/restore, snapshot, search, and
virtualization behavior within each session remains the existing
single-session behavior. Cross-session implementation supplies isolation but
does not add alternate rules for those features.

## 3. Formal correctness properties

Let `events(S)` be the event sequence owned by session `S`, and let
`single(events(S))` be the accepted single-session implementation result.

For a globally interleaved trace `T` containing sessions A through N:

```text
project(runCrossSession(T), S) == single(filter(T, sessionId == S))
```

This is the **interleaving equivalence invariant**.

For any event `e` owned by A:

```text
project(dispatch(globalState, e), B) == project(globalState, B)
```

for all `B != A`. This is the **non-interference invariant**.

For visibility changes:

```text
select(globalState, B).sessions == globalState.sessions
```

Only selection and B's presentation cursor may change. This is the
**selection purity invariant**.

For a terminal turn generation `g`:

```text
phase(S, g) in terminal
=> every later state for (S, g) remains terminal
```

This is the **terminal monotonicity invariant**.

All four properties must be executable tests, not documentation-only claims.

## 4. Architectural pattern

The implementation uses a lightweight actor/reducer pattern without requiring
an XState dependency.

Each session is an independent runtime instance:

```ts
type SessionId = string;

interface SessionActor {
  readonly sessionId: SessionId;
  dispatch(event: OwnedSessionEvent): Promise<void>;
  getSnapshot(): SessionSnapshot;
  subscribe(listener: (snapshot: SessionSnapshot) => void): Disposable;
}
```

Every actor:

- owns one session state;
- processes its mailbox sequentially;
- uses the same single-session transition functions;
- emits immutable snapshots;
- executes effects carrying its captured session and turn identity.

Different session actors may execute concurrently. Events within one session
are serialized.

The global layer is deliberately small:

```ts
interface SessionRegistry {
  getOrCreate(sessionId: SessionId): SessionActor;
  route(event: OwnedSessionEvent): Promise<void>;
  select(sessionId: SessionId): void;
  getVisibleSessionId(): SessionId | null;
}
```

`select` never dispatches a business event to an actor.

## 5. One single-session core, not one giant reducer

“One single-session core” means one behavioral composition root, not one large
file.

```ts
function reduceSingleSession(
  state: SessionState,
  event: SessionEvent
): SessionTransition {
  return sessionEventTable[event.type](state, event);
}
```

The event table delegates to existing feature semantics:

- turn lifecycle;
- assistant identity;
- append;
- tools and todos;
- subagents;
- history and hydration;
- changelists;
- segments and undo/restore presentation;
- composer and per-session UI state.

An event handler may coordinate more than one feature reducer when the existing
single-session behavior requires ordered updates. That ordering is explicit in
one application handler and is covered by a characterization test.

Feature reducers do not call DOM, VS Code APIs, filesystem, Git, timers, or
network APIs. They return effects:

```ts
type SessionTransition = {
  state: SessionState;
  effects: SessionEffect[];
};
```

Effects are executed by adapters and return results as new owned events.

## 6. State ownership

Having both Extension and Webview state is acceptable only when ownership is
explicit. Mirroring is not shared authority.

| State | Authoritative writer | Other layers |
| --- | --- | --- |
| Backend turn lifecycle | Extension session actor | Webview read-only mirror |
| Turn generation and event sequence | Extension session actor | Webview validates |
| Canonical user/assistant IDs | Extension session actor | Webview indexes for display |
| Streaming assistant text | Extension session actor from backend events | Webview projection |
| Append backend status | Extension single-session append handler | Webview projection |
| Subagent lifecycle | Extension single-session subagent handler | Webview projection |
| Durable messages/snapshot | Snapshot/history services | Actors hydrate versioned history |
| Changelist/Git ownership | Extension changes/undo services | Webview renders canonical anchor |
| Segment file semantics | Extension undo service | Webview owns only presentation state |
| Visible session ID | Webview shell | Extension receives explicit command targets |
| Per-session draft/search/scroll | Webview session state | Not inferred by Extension |
| Mounted DOM window | Virtualizer | Never treated as domain state |

The Webview may optimistically create the user and assistant presentation for a
new command, but the optimistic action carries the Extension-issued turn
generation or a command token that is atomically bound by the Extension.

## 7. Event and command protocol

All asynchronous session traffic uses an owned envelope:

```ts
interface SessionEnvelope<TType extends string, TPayload> {
  type: TType;
  sessionId: string;
  sessionEpoch: number;
  turnGeneration?: number;
  sequence: number;
  commandId?: string;
  payload: TPayload;
}
```

Rules:

1. `sessionId` is mandatory after command ingress.
2. `sessionEpoch` distinguishes a recreated runtime for the same backend
   session.
3. `turnGeneration` is mandatory for turn-owned traffic.
4. `sequence` is monotonic within a session epoch.
5. The router drops missing or stale ownership.
6. No fallback to `visibleSessionId` is allowed after ingress.
7. Duplicate envelopes are idempotent.
8. A gap in delta events triggers a full session projection request rather than
   guessing.

Selection/hydration request IDs are separate from turn sequence and ensure an
older request cannot activate a session after a newer selection.

## 8. Assistant identity without cross-session heuristics

The existing failure occurs because temporary, internal, and canonical IDs are
stored across several maps and selected using current timeline/index state.

The new single-session identity module owns one binding:

```ts
interface AssistantBinding {
  entityId: string;       // stable presentation identity
  temporaryId?: string;
  canonicalId?: string;
  canonicalIndex?: number;
}
```

- `entityId` never changes and is used by rendering and virtualization.
- `canonicalId` is used by persistence, changelists, Git, and undo ownership.
- Binding occurs only inside the owning session actor and turn generation.
- Canonicalization updates binding data; it does not rename keys throughout
  unrelated state.
- Existing single-session bubble ordering and appearance remain unchanged.

If stable entity migration proves too broad for one slice, an interim identity
adapter may retain current keys behind this interface. No caller outside the
identity module may perform key replacement.

## 9. Main-assistant lifecycle

The single-session turn module exposes a finite lifecycle:

```ts
type TurnPhase =
  | 'submitted'
  | 'streaming'
  | 'waiting'
  | 'finalizing'
  | 'finalized'
  | 'failed'
  | 'cancelled';
```

This does not change product behavior; it replaces contradictory Boolean
combinations with explicit states.

Only the Extension session actor transitions lifecycle. The Webview consumes
the resulting phase.

Main-assistant finalization is one terminal actor transition:

- bind canonical assistant identity;
- freeze final assistant text;
- mark append/subagent projection consistently with existing single-session
  behavior;
- detach runtime resources;
- initiate changelist/snapshot effects;
- emit a terminal session projection.

Snapshot or changelist failure is attached as an artifact result and cannot
return the main assistant to active.

All terminal paths call the same transition:

- normal final;
- error;
- cancellation;
- hard stop;
- reconnect resolution.

## 10. Hydration and reload

Hydration updates one actor and never selects it.

Durable hydration contains:

- snapshot history;
- only messages proven newer than the snapshot;
- canonical changelists and segments;
- a history revision.

Active runtime state comes from the Extension session actor, not from snapshot
fields and not from Webview volatile-field preservation.

Merge precedence:

1. Newer terminal turn projection.
2. Newer active turn generation/sequence.
3. Newer durable history revision.
4. Older payload is ignored.

Snapshot remains an exact record of intended visible durable history. Remote
messages intentionally hidden by the user are not reintroduced merely because
they exist remotely.

## 11. Rendering and virtualization

The Webview derives render units from exactly one selected session snapshot:

```ts
const snapshot = sessionViewStore.get(visibleSessionId);
const units = projectSingleSession(snapshot);
virtualizer.mount(units);
```

- `projectSingleSession` contains existing single-session presentation rules.
- Background events never call the DOM renderer.
- Selecting a session projects it and scrolls to bottom.
- Virtualization controls mounting only.
- Virtualization cannot infer ownership, finality, append visibility, segment
  order, or changelist placement.
- Full rendering and virtualized rendering consume identical ordered units.

## 12. Module layout

### 12.1 Shared protocol and pure domain

```text
shared/session-runtime/
  protocol.ts
  identity.ts
  lifecycle.ts
  invariants.ts
```

No VS Code, DOM, filesystem, Git, timers, or global state dependencies.

### 12.2 Extension application

```text
src/session-runtime/
  SessionActor.ts
  SessionRegistry.ts
  SessionCommandRouter.ts
  SessionEventRouter.ts
  SessionEffectRunner.ts
  SessionProjectionPublisher.ts
  ports.ts
  turn/
    turn-reducer.ts
    turn-finalization.ts
    assistant-binding.ts
  append/
    append-reducer.ts
  subagents/
    subagent-reducer.ts
  history/
    hydration-coordinator.ts
```

Existing `src/changes`, `src/undo`, `src/history`, and transport modules remain
service owners behind typed ports.

### 12.3 Webview application

```text
webview-src/session-runtime/
  session-view-store.ts
  session-view-reducer.ts
  session-selection-controller.ts
  session-projection.ts
  session-event-router.ts
  turn/
    turn-view-reducer.ts
    assistant-presentation.ts
  append/
    append-view-reducer.ts
  subagents/
    subagent-view-reducer.ts
  history/
    hydration-reducer.ts
```

Existing rendering, search, changelist, segment, composer, and undo modules are
called through typed feature interfaces.

### 12.4 Composition surfaces

- `SidebarProvider.ts` constructs Extension services and delegates.
- `SidebarWebviewController.ts` validates commands and captures target session.
- `OpenCodeClient.ts` adapts transport events but does not own UI session
  lifecycle.
- `media/main.js` wires bundles, DOM adapters, and the selected-session render
  subscription.

These entry files must not become secondary stores.

## 13. Current-to-target ownership map

The following is the concrete migration map from the inspected 2026-07-23
codebase.

| Current owner/surface | Current responsibility | Target owner | Migration rule |
| --- | --- | --- | --- |
| `SidebarProvider.sendInFlightBySession` | Per-session streaming flag | `SessionActor` turn phase | Shadow-read first, then delete the Map after lifecycle cutover |
| `SidebarProvider.pendingAssistantMessageIdBySession` | Internal/finalizing assistant proof | `turn/assistant-binding.ts` | Binding belongs to one session generation; it is not an active-turn flag |
| `SidebarProvider.pendingAssistantTmpKeyBySession` | Temporary assistant identity | `turn/assistant-binding.ts` | No other service may read or delete it directly |
| `SidebarProvider.pendingLocalKeyBySession` | Optimistic user identity | Session identity binding | Captured in the command and resolved only for that actor |
| `ActiveTurnTracker` | Reconstructs active/finalizing from separate containers | Session selectors over `TurnPhase` | Remove inference after actor phase becomes authoritative |
| `OpenCodeClient` turn/final/finalizing Maps | Backend lifecycle and canonical IDs | Extension actor plus transport adapter | Client reports owned backend facts; actor decides transitions |
| `TurnFinalizationCoordinator` | Multi-step finalization with separately visible phases | Actor terminal transition plus effect runner | Artifact effects cannot reopen lifecycle |
| `media/main.js::attemptAssistantUpgrade` | Selects and rekeys temporary/canonical assistant | Webview assistant presentation reducer | Consumes authoritative binding; no timeline/index heuristic |
| `media/main.js::replaceKeyEverywhere` | Cross-domain identity mutation | Identity module adapter, then removal | No new caller; migrate one domain at a time behind stable entity ID |
| Webview `thinkingId/currentTurnAssistant*` | Duplicated lifecycle and identity | `turn-view-reducer.ts` projection | Read-only mirror of owned session envelopes |
| Webview `backendTurnInFlight/turnFullyFinalized` | Contradictory lifecycle Booleans | Mirrored `TurnPhase` | Compatibility selectors only during migration |
| Webview `pendingAssistantUpgrade/finalAssistantLock` | Recovery protocol | Assistant binding projection | Remove after versioned binding is accepted |
| `hydration-state-controller.ts` volatile preservation | Restores live fields over history | `history/hydration-reducer.ts` | Compare history/session/turn revisions; never copy lifecycle fields |
| `session-store.ts` | Untyped Map of broad session objects | `session-view-store.ts` | Typed snapshots; mutation only through reducer dispatch |
| `session-event-router.ts` | Ownership routing plus rendering effects | Router plus selection controller | Router returns actor target; selection controls rendering separately |
| `renderIfActive` calls | Conditional render scattered across events | Selected-session subscription | One subscription renders when selected snapshot changes |
| `media/main.js` | State, routing, presentation, DOM, recovery | Composition and DOM adapter | Business writes decrease on every accepted migration |

### 13.1 Current size baseline

The inspected source baseline is:

| File | Lines |
| --- | ---: |
| `media/main.js` | 17,372 |
| `src/SidebarProvider.ts` | 5,611 |
| `src/OpenCodeClient.ts` | 6,601 |
| `src/webview/SidebarWebviewController.ts` | 2,259 |
| `src/events/SidebarChatEventHandler.ts` | 765 |
| `webview-src/continuation/hydration-state-controller.ts` | 287 |

These numbers are diagnostics, not permission for mechanical splitting. The
accepted direction is:

- event/controller entry files shrink as behavior moves to cohesive modules;
- no extracted module becomes a similarly sized replacement;
- state writes decrease in entry files;
- broad host surfaces become typed ports;
- source-size improvements must accompany ownership and test improvements.

## 14. Dependency direction

```text
shared protocol/domain
        ↑
extension session application ← extension infrastructure adapters

shared protocol/domain
        ↑
webview session application ← DOM/rendering adapters
```

Rules:

- Domain modules import no adapters.
- Feature reducers import only shared types and their own feature types.
- Routers know registry interfaces, not concrete feature internals.
- Rendering reads projections and dispatches UI commands; it cannot mutate
  session state directly.
- Infrastructure never chooses the visible session for ownership.
- Circular dependencies are prohibited.
- Boundary types may not use `any` or `Record<string, any>`.

## 15. Maintainability standards

The refactor is accepted by cohesion and dependency quality, not line-count
reduction alone.

Guidelines:

- One state domain has one writer.
- One module has one named responsibility.
- Public host/port interfaces are narrow and capability-based.
- Pure transition logic is separated from effects.
- New business behavior requires a reducer test before adapter integration.
- New event types require protocol ownership and stale-event tests.
- New session features automatically receive isolation tests.
- Source files above roughly 500 lines require explicit review for another
  split; files above roughly 800 lines are not accepted without a documented
  reason.
- A facade may be long only when it is declarative wiring; it may not contain
  hidden business branches.
- Extracted modules must reduce, not duplicate, writers in `media/main.js`,
  `SidebarProvider.ts`, and `OpenCodeClient.ts`.

The line guidance is a review trigger, not permission for artificial or
mechanical splitting.

## 16. Testing architecture

### 16.1 Single-session characterization

Before migrating a feature, capture current accepted behavior for:

- normal send/stream/final;
- tools and todos;
- append;
- subagents;
- error/cancel;
- snapshot/reload;
- changelists;
- undo/restore and nested segments;
- long-session virtualization and search.

These tests are the compatibility oracle.

### 16.2 Differential tests

For each migrated trace:

```text
legacySingleSession(trace) == newSingleSessionCore(trace)
```

Compare domain state and render projection, ignoring approved implementation
metadata only.

### 16.3 Interleaving tests

Generate deterministic permutations of A, B, and C traces and prove:

```text
project(globalResult, A) == singleResult(A)
project(globalResult, B) == singleResult(B)
project(globalResult, C) == singleResult(C)
```

Include selection changes at every event boundary.

### 16.4 Terminal monotonicity tests

After main assistant finalization, inject:

- old chunks;
- old assistant metadata;
- delayed subagent running events;
- old hydration;
- duplicate final;
- reload/resume messages.

The assistant remains canonical and terminal.

### 16.5 Virtualization equivalence

The ordered render projection must be identical for:

- full mount;
- top/middle/bottom windows;
- search-centered windows;
- fast scrollbar jumps;
- selection away and back.

### 16.6 Real UI acceptance

At every high-risk wave:

1. Start A, switch to B, start B.
2. Switch repeatedly while both stream.
3. Let A final in background and return to A.
4. Let B final while visible.
5. Repeat with append, tools, and subagents.
6. Reload during active and after final.
7. Verify changelists, undo/restore, search, and fast scrolling.

## 17. Incremental migration

### Phase 0: freeze accepted single-session behavior

- Build reusable trace fixtures from current tests and debug logs.
- Add formal interleaving/non-interference/selection-purity assertions.
- Encode the current temporary-after-final and disappearing-assistant failures.
- Make no production routing change.

Exit gate: compatibility oracle covers all named high-risk features.

### Phase 1: shared protocol and typed boundaries

- Add owned envelope, session epoch, turn generation, and sequence types.
- Replace broad hosts for the migrated path with typed ports.
- Add protocol validation and diagnostic-only shadow routing.

Exit gate: compile, protocol tests, no runtime behavior change.

### Phase 2: session registry in shadow mode

- Create one Extension actor and one Webview view instance per session.
- Feed existing events to legacy and new shadow paths.
- Compare state ownership and lifecycle decisions without rendering the shadow
  path.

Exit gate: zero unexplained shadow divergence for single and interleaved
traces.

### Phase 3: migrate single-session lifecycle

- Move assistant binding and turn lifecycle out of `media/main.js`,
  `SidebarProvider`, and `OpenCodeClient` into the session modules.
- Preserve accepted single-session output exactly.
- Make main-assistant terminal transition monotonic and shared by all ending
  paths.

Exit gate: final/temporary regressions and all single-session lifecycle tests
pass.

### Phase 4: switch production cross-session routing

- Route explicit owned events into target actors.
- Make selection render-only and auto-scroll bottom.
- Allow independent concurrent sends.
- Remove active-session fallback from asynchronous paths.

Exit gate: interleaving and manual A/B/C acceptance pass.

### Phase 5: migrate hydration and identity storage

- Separate durable history from active projection.
- Introduce stable entity/canonical binding behind the identity module.
- Remove volatile-field preservation and broad key replacement from migrated
  paths.

Exit gate: reload, snapshot, changelist, undo/restore, and virtualization
equivalence pass.

### Phase 6: migrate remaining feature reducers

- Append, subagents, history presentation, and other session-scoped UI state
  move behind the single-session composition root.
- Reuse current semantics and characterization fixtures.

Exit gate: complete single-session differential suite and cross-session
interleaving suite pass.

### Phase 7: delete legacy writers and facades

- Remove duplicate maps, flags, fallback recovery, and shadow code.
- Reduce entry files to composition/adapters.
- Update modularization architecture and ownership tables.

Exit gate: repository audit finds one writer per state domain, no broad
identity mutation outside its owner, no ownership fallback to visible session,
and all automated/manual gates pass.

## 18. Commit and rollback policy

- One behavioral slice and its direct tests per commit.
- Characterization, typed boundary, migration, and docs are separate commit
  categories.
- Every production migration is independently revertible.
- Stage only explicit files; preserve existing user outputs and untracked
  files.
- No dependent phase begins until the prior exit gate passes.
- A failed UI gate causes revert of the smallest migration commit, not
  compensating patches across unrelated modules.

## 19. Completion criteria

The cross-session implementation is complete only when:

1. All accepted single-session traces are behaviorally unchanged.
2. Interleaving equivalence passes for every migrated feature.
3. A, B, and C can run independently and concurrently.
4. Selection is render-only and returns to the latest state at the bottom.
5. Main-assistant finality is terminal and canonical.
6. Hydration/reload cannot revive temporary state.
7. Append, subagent, changelist, undo/restore, search, and virtualization match
   their single-session behavior.
8. Entry files are composition surfaces rather than business-state owners.
9. Each state domain has one authoritative writer and typed boundaries.
10. Automated gates and the real UI matrix both pass.

## 20. Implementation checkpoint (2026-07-23)

The migration is implemented through the production-routing and identity
boundaries, with the legacy presentation structures retained as compatibility
projections until the real UI matrix is accepted.

Implemented owners:

- `src/session-runtime/protocol.ts`: owned event envelope, epoch, and sequence.
- `src/session-runtime/SessionActor.ts` and `SessionRegistry.ts`: one serialized
  execution queue per session with concurrency across sessions.
- `src/session-runtime/ChatEventActorRouter.ts`: production `ChatEvent` routing;
  parent-visible subagent effects use the parent actor.
- `src/session-runtime/turn/turn-reducer.ts`: monotonic reference lifecycle.
- `webview-src/session-runtime/assistant-binding.ts`: session-owned temporary to
  canonical assistant selection.
- `webview-src/session-runtime/turn-lifecycle.ts`: main-assistant terminal state
  separated from cleanup-effect completion.
- `webview-src/session-runtime/message-identity.ts`: stable entity identity
  preserved across compatibility rekeys.
- `webview-src/session-runtime/session-selection-controller.ts`: immediate
  render-only selection with forced bottom scroll.
- `webview-src/continuation/hydration-state-controller.ts`: authoritative
  durable payload plus active-turn-only projection overlay.

Production ownership rules now enforced:

- asynchronous assistant, text, error, user-ack, diff, permission, and file
  events do not fall back to the visible session;
- background assistant permission is derived from the event-owned session,
  never the selected session;
- same-session events are serialized, while different sessions progress
  concurrently;
- `chatDone` seals the main assistant before `finalize_done` completes snapshot,
  diff, and other effects;
- selecting a cached session renders it immediately and scrolls to the bottom
  before hydration returns;
- hydration cannot restore unrelated cached durable records that are absent
  from the authoritative payload.

Automated acceptance at this checkpoint:

- 134 Jest suites and 1061 tests pass;
- Extension and Webview compilation pass;
- all four Webview bundles remain within size limits;
- deterministic rendering bundle check passes;
- VSIX content policy passes.

Still required before deleting compatibility projections and diagnostic shadow
state:

- run the real UI A/B/C matrix in section 16.6;
- inspect `[EXT][TURN_SHADOW_DIVERGENCE]` and
  `[EXT][SESSION_ACTOR_ERROR]` output;
- only after zero unexplained divergence, remove the shadow path and remaining
  compatibility writers in a separate reversible commit.
