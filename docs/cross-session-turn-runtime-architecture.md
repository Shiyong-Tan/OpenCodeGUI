# Cross-session turn runtime architecture

## Status

Proposed replacement architecture for active-turn rendering, assistant identity
binding, session switching, hydration, append continuation, and finalization.

This design intentionally replaces the current collection of independently
mutable flags and identity maps. Adding more ordering checks to the existing
flags is not considered a sufficient fix.

## Problem statement

The UI must support the following without losing or duplicating content:

1. Start a turn in session A.
2. Switch to session B while A continues in the background.
3. Receive streaming text, tools, subagents, append prompts, canonical backend
   message IDs, and finalization events for either session.
4. Switch back to A at any point.
5. Render exactly the state A had reached, without replaying stale hydration
   over it.
6. Once a turn is final, never render its assistant as temporary, thinking,
   streaming, or finalizing again.

No implementation can be declared bug free merely from code inspection. The
design below makes the required behavior deterministic and supplies invariants
and interleaving tests that can prove the implementation covers this state
space.

## Evidence from the 2026-07-23 debug log

The affected session was `ses_073d5a593ffeCc6ARpsJF8rgWh`.

- The backend assistant ID
  `msg_f8fb31a7b001i8QYO5q9c4Km5z` arrived with the temporary UI key
  `tmp:1784822225854-1v2acbpw`.
- `attemptAssistantUpgrade` selected the stale
  `currentTurnAssistantKey=msg_f8fb1dbd7001f25lSPsEoF2Rp8` before considering
  the event's temporary key. The upgrade therefore logged
  `replaced=false reason=no-change`.
- A later authoritative message-index retry made the same selection and again
  did not replace the current temporary entity.
- Hydration then preserved `pendingAssistantUpgrade`, `thinkingId`,
  `currentTurnAssistantKey`, `currentTurnAssistantMsgId`,
  `backendTurnInFlight`, and `turnFullyFinalized` together with the live tail.
  This restored a contradictory runtime state rather than resolving it.
- The extension continued reporting `streaming=true finalizing=true` for
  several minutes because active state is derived from
  `sendInFlightBySession` and `pendingAssistantMessageIdBySession`, two
  separately cleaned containers.
- The session produced a `step-finish` part, but the log does not contain a
  session-owned `chatDone` or `finalize_done` for this turn. A model step
  finishing is not protocol proof that the whole turn finalized.

The failure is therefore a combination of stale identity selection, multiple
state authorities, non-atomic finalization, and hydration that preserves
invalid combinations.

## Current architectural defects

### Multiple mutable authorities

The same logical turn is represented independently in at least three places:

- `OpenCodeClient`: turn state, final/finalizing IDs, append successor state,
  message IDs, indexes, and completion detection.
- `SidebarProvider`: send-in-flight, pending local user, pending temporary
  assistant, pending internal assistant, buffered text, active-turn freshness,
  and snapshot inputs.
- Webview session state: `thinkingId`, `currentTurnAssistantKey`,
  `currentTurnAssistantMsgId`, `pendingAssistantUpgrade`,
  `finalAssistantLock`, `earlyFinalAssistantId`,
  `awaitingFinalMapBind`, `backendTurnInFlight`, and
  `turnFullyFinalized`.

These representations can be individually valid while disagreeing with each
other.

### Booleans permit impossible states

Independent flags permit combinations such as:

- `backendTurnInFlight=true` and `turnFullyFinalized=true`;
- final canonical assistant present while `thinkingId` still targets a
  temporary message;
- `pendingAssistantUpgrade` present after a final lock;
- extension streaming false but finalizing true forever because one pending map
  entry survived cleanup.

Code at every read site must currently guess which field has precedence.

### Identity is used as storage location

Temporary keys, local keys, internal assistant IDs, and canonical backend IDs
are used as keys in timelines and maps. Canonicalization therefore requires
`replaceKeyEverywhere`, alias maps, fallback locks, index comparison, and
render-time heuristics.

A delayed event can accidentally rename or bind the wrong turn because the
identity itself does not contain a turn generation.

### Finalization is a sequence of unrelated UI events

The extension currently sends `chatDone`, phase events, index maps,
change-list data, snapshots, `turnInFlight:false`, and additional compensation
events across asynchronous boundaries. The Webview can hydrate or switch
sessions between any two steps and observe a partial final state.

### Hydration merges lifecycle state

Historical hydration is allowed to preserve arbitrary volatile fields from the
existing Webview session. This protects live text from stale snapshots, but it
also preserves stale lifecycle and identity fields after canonical history has
already proved a newer state.

### Rendering contains domain decisions

Presentation helpers decide whether append assistants are intermediate,
current, hidden, or final by examining mutable runtime fields. Virtualization
then receives candidates that may already embody an incorrect lifecycle
decision.

## Target ownership model

### One extension-side authority

Introduce one `TurnRuntimeStore` in the extension host. It is the only mutable
authority for turn lifecycle and assistant binding.

```ts
type TurnPhase =
  | 'submitted'
  | 'streaming'
  | 'waiting-tools'
  | 'finalizing'
  | 'finalized'
  | 'failed'
  | 'cancelled';

type TurnKey = {
  sessionId: string;
  generation: number;
};

type AssistantIdentity = {
  entityId: string;       // immutable UI identity for this turn's assistant
  canonicalId?: string;  // backend msg_* identity when proven
  messageIndex?: number;
};

type TurnRuntime = {
  key: TurnKey;
  revision: number;
  phase: TurnPhase;
  rootUserEntityId: string;
  canonicalUserId?: string;
  assistant: AssistantIdentity;
  text: string;
  statusText: string;
  appendPrompts: AppendPromptState[];
  subagents: SubagentState[];
  startedAt: number;
  finalizedAt?: number;
  terminalReason?: string;
};
```

There is at most one non-terminal `TurnRuntime` per session. Starting another
turn increments `generation`. All async operations capture the full `TurnKey`.

`SidebarProvider`, liveness, snapshot writing, append, and change-list code
query this store. They do not maintain parallel pending maps.

### Stable UI entity identity

Do not rename timeline/map keys when a canonical backend ID arrives.

- `entityId` is created once when the UI turn begins and remains the render
  key for the lifetime of the message.
- `canonicalId` is data attached to that entity.
- Backend events locate an entity through `{sessionId, generation}` first and
  then validate the canonical ID.
- Snapshots persist canonical messages. In-memory projection associates the
  canonical snapshot message with the existing entity without changing its
  render key.

This removes `replaceKeyEverywhere`, ID-selection by message index, and most
temporary/canonical alias recovery.

### Versioned reducer protocol

Every extension-to-Webview turn event uses one envelope:

```ts
type TurnEventEnvelope<T> = {
  sessionId: string;
  generation: number;
  revision: number;
  type: T;
};
```

The extension store increments `revision` for every accepted transition. The
Webview uses a pure reducer and applies an event only when:

1. its `generation` is newer than the stored generation; or
2. its generation matches and its revision is newer.

Events from an older turn or an earlier phase become harmless no-ops.

Recommended event types:

- `turnStarted`
- `turnProgressed`
- `assistantCanonicalized`
- `turnPhaseChanged`
- `turnFinalized`
- `turnFailed`
- `turnCancelled`

High-frequency text may use deltas with a contiguous sequence number, but a
periodic full-text checkpoint must allow recovery from a dropped delta.

### Explicit transition table

Allowed phase transitions:

| From | To |
| --- | --- |
| none | submitted |
| submitted | streaming, failed, cancelled |
| streaming | waiting-tools, finalizing, failed, cancelled |
| waiting-tools | streaming, finalizing, failed, cancelled |
| finalizing | finalized, failed, cancelled |

Terminal phases never transition. Duplicate terminal events are idempotent only
when `{generation, canonicalId, terminal phase}` agree.

`step-finish` may move `streaming` to `waiting-tools` or `finalizing` only when
the backend completion detector supplies the required proof. It must never
directly imply `finalized`.

### Atomic finalization

Finalization is a transaction in the extension store:

1. Resolve and validate the final canonical assistant ID for the captured
   `TurnKey`.
2. Bind undo/change-list ownership to that canonical ID.
3. Build final canonical message and artifact state.
4. Attempt snapshot persistence. Snapshot failure is recorded but does not
   prevent turn finality.
5. Transition the store once to `finalized`.
6. Clear all non-terminal resources as part of the same store transition.
7. Emit one `turnFinalized` envelope containing the canonical assistant,
   final text, artifact ownership, and snapshot result.

The Webview reducer handles `turnFinalized` atomically:

- set canonical ID and final text;
- set phase to `finalized`;
- clear thinking/status/pending fields;
- make the assistant visible;
- recompute render projection once.

Commit, snapshot, or UI compensation code must not send lifecycle flags after
the terminal envelope.

### Session switching

Selecting a session changes only:

```ts
visibleSessionId: string
```

It does not reset, hydrate, finalize, or clone turn state.

Background envelopes always update their owned session in the Webview store.
They render only if their session equals `visibleSessionId`. Switching back
renders the already current store projection immediately.

If a session is absent from memory, selection requests one versioned hydration
payload. Multiple hydration requests for the same selection have request IDs;
only the newest response may activate the session.

### Hydration and snapshots

Snapshots contain durable history only:

- canonical user/assistant messages;
- segment topology;
- change-list ownership;
- append presentation metadata that is finalized or explicitly durable.

Snapshots never contain active lifecycle flags, temporary IDs, thinking
status, or pending upgrades.

A hydration payload contains:

```ts
type SessionHydration = {
  sessionId: string;
  requestId: string;
  historyRevision: number;
  messages: CanonicalMessage[];
  segments: SegmentState[];
  changes: ChangeListState[];
  activeTurn?: TurnRuntimeProjection;
};
```

`activeTurn`, when present, comes from the authoritative extension
`TurnRuntimeStore`, not from snapshot reconstruction.

Merge rules:

1. Lower `historyRevision` never replaces higher history.
2. Canonical history is merged by canonical message ID and stable ordering
   metadata.
3. The active-turn projection is compared by generation and revision.
4. Historical hydration never copies Webview volatile fields back over the
   active-turn projection.
5. A finalized canonical message with the same turn generation dominates any
   non-terminal projection.

### Append semantics

Append prompts are ordered inputs owned by the same `TurnKey` until the backend
explicitly creates a successor generation.

- Appending text does not change the assistant entity key.
- If the backend creates a successor assistant message within the same logical
  turn, it updates `assistant.canonicalId` only after predecessor/successor
  ownership is proven.
- If product semantics require a second assistant bubble, create a distinct
  assistant entity explicitly in the turn projection; do not infer it from
  parent IDs during rendering.
- Intermediate assistant visibility is a projection field produced by the
  turn reducer, not a renderer heuristic.
- Finalization freezes append ordering and ownership before snapshot
  persistence.

### Rendering and virtualization

Rendering consumes a pure projection:

```ts
type RenderUnit = {
  entityId: string;
  kind: 'user' | 'assistant' | 'segment' | 'change-list' | 'surface';
  visible: boolean;
  lifecycle?: TurnPhase;
  contentRevision: number;
};
```

The projection layer owns ordering and visibility. The virtualizer owns only
which projected units are mounted. Neither the renderer nor virtualizer may
change turn state, canonicalize IDs, infer finality, or move messages.

This keeps long-session virtualization compatible with cross-session turns:
the same projection produces the same ordering whether all units or a window
are mounted.

## Required invariants

The implementation must assert these in development and test builds:

1. A session has at most one non-terminal turn generation.
2. A terminal generation can never return to a non-terminal phase.
3. A finalized assistant always has a canonical `msg_*` ID.
4. A finalized assistant is never thinking, temporary, pending-upgrade, or
   hidden as an intermediate append assistant.
5. Every turn event has explicit `{sessionId, generation, revision}`.
6. No async continuation reads the currently visible session as ownership.
7. Hydration cannot decrease history revision, turn generation, or turn
   revision.
8. Snapshot data cannot overwrite an active-turn projection.
9. Render ordering is independent of mount window and session visibility.
10. Undo, restore, change lists, and git ownership reference canonical message
    IDs while UI rendering references stable entity IDs.
11. Cleanup of terminal runtime resources is one store operation, not a list
    of unrelated map deletions.
12. Missing ownership, generation, or invalid transitions are dropped and
    logged; they never fall back to the visible session.

## Verification strategy

### Reducer transition tests

Exhaustively test every allowed and disallowed phase transition, terminal
idempotence, canonical binding, and stale revision rejection.

### Model-based interleaving tests

Generate event permutations for two sessions A and B:

- stream A, select B, canonicalize A, finalize A, select A;
- select during each finalization boundary;
- hydrate before and after canonicalization/finalization;
- duplicate and reorder canonicalization, finalization, and hydration;
- append before canonicalization, during tools, and immediately before final;
- cancel/error at every phase;
- subagent updates before and after parent finalization;
- snapshot success and failure.

After every event, assert all invariants and compare the rendered projection
with a small reference model.

### Virtualization equivalence tests

For the same store state, compare:

- full projection ordering;
- top, middle, bottom, and anchor-centered virtual windows;
- session switch away and back;
- rapid scrollbar jumps.

Mounted subsets may differ; canonical ordering, unit identity, content, and
visibility must not.

### End-to-end log scenarios

Logs use one line per accepted transition:

```text
[TURN] session=<id> generation=<n> revision=<n>
       event=<type> from=<phase> to=<phase>
       entity=<id> canonical=<id|null> render=<active|background>
```

Acceptance requires:

- no transition without session/generation/revision;
- exactly one terminal transition per generation;
- switching sessions changes render ownership only;
- after `turnFinalized`, no later line for that generation reports a
  non-terminal phase or temporary assistant.

## Migration plan

### Phase 0: characterization

- Add a reference-model test harness around current events.
- Encode the attached failure and all previously reported switch/append/final
  regressions as failing scenarios.
- Add invariant logging without changing production behavior.

### Phase 1: extension `TurnRuntimeStore`

- Introduce the store and adapters from existing event sources.
- Make liveness and busy state read the store.
- Keep legacy maps temporarily as shadow state and assert equality.
- Do not switch production Webview protocol yet.

Exit gate: shadow-state mismatches are zero across automated scenarios and
manual A/B session switching.

### Phase 2: versioned Webview reducer

- Add versioned turn envelopes and a reducer in a small Webview module.
- Render a shadow projection and compare it with the legacy projection.
- Stop hydration from restoring lifecycle fields; use the extension active
  projection.

Exit gate: randomized interleaving and hydration tests pass.

### Phase 3: stable entity IDs

- Separate UI entity ID from canonical backend ID.
- Migrate assistant rendering, append presentation, search anchors, segment
  topology, and virtualization keys.
- Remove key replacement from the new path.

Exit gate: virtualization equivalence and undo/restore/change-list ownership
tests pass.

### Phase 4: atomic finalization

- Replace the multi-event final lifecycle with `turnFinalized`.
- Move cleanup into the terminal store transition.
- Retain artifact progress as non-lifecycle events if needed.

Exit gate: no terminal generation can re-enter temporary state under any
generated interleaving.

### Phase 5: remove legacy state

- Delete duplicate provider maps and Webview lifecycle flags.
- Delete assistant key-replacement fallbacks and active-session ownership
  fallbacks.
- Keep compatibility adapters only at external OpenCode event boundaries.

Exit gate: repository grep confirms one lifecycle authority and one reducer;
all unit, model, virtualization, undo/restore, append, snapshot, and manual
session-switch gates pass.

## Immediate containment before migration

The architecture migration should not leave the current product broken.
A narrowly scoped containment patch may:

1. Prefer an event-provided temporary key that is proven to belong to the
   current turn over a stale `currentTurnAssistantKey`.
2. Prevent hydration from preserving non-terminal fields when canonical
   history or a terminal lock proves the same assistant is final.
3. Make terminal cleanup unconditional and idempotent for all provider maps.
4. Add an explicit diagnostic when a `step-finish` occurs without a later
   turn-terminal event.

These changes reduce current failures but are not substitutes for the target
architecture.

