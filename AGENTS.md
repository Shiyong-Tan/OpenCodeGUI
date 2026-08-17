# OpenCode GUI coding rules

These rules apply to every code, test, documentation, and configuration change in
this repository. They are intentionally stricter around session state and Webview
rendering because regressions in those areas are difficult to reproduce and costly
to validate manually.

## 1. Read the architecture before changing behavior

For changes involving sessions, history, rendering, or refactoring, read the
relevant documents first:

- `docs/modularization-architecture.md`
- `docs/cross-session-isolated-single-session-architecture.md`

Treat the ownership tables and critical invariants in those documents as contracts,
not suggestions. If code and documentation disagree, stop and establish which
behavior is currently accepted before changing either one.

## 2. Preserve one owner and one source of truth

Every mutable fact must have exactly one canonical owner. Before editing, identify:

1. the state being changed;
2. the module that owns it;
3. the stable identity that addresses it, such as `sessionId`, `turnId`, generation,
   canonical message ID, or operation ID;
4. the projections that merely display or cache it.

Do not create a second writer in a controller, renderer, cache, compatibility facade,
or asynchronous callback. DOM nodes, hydrated payloads, snapshots, overlays, and
presentation caches are projections unless the architecture explicitly says
otherwise.

## 3. Keep entry files as composition surfaces

- `src/SidebarProvider.ts` composes extension-side services and bounded command
  hosts. New domain logic belongs in an owner under `src/<capability>/` or an existing
  bounded controller.
- `src/OpenCodeClient.ts` owns OpenCode transport and turn-runtime integration. New
  protocol calls should use a focused method; unrelated UI decisions do not belong
  there.
- `media/main.js` is a compatibility and Webview composition surface. Prefer a typed
  module under `webview-src/` for new state, decisions, or reusable behavior.
- Controllers translate protocol messages into calls to domain owners. They must not
  become alternate state stores.

Do not mechanically split a large file. Extract a cohesive capability only when its
inputs, outputs, state owner, and tests are clear. Moving code without clarifying
ownership increases risk and does not count as a successful refactor.

As a default, a substantial new feature or a block of roughly 150 or more lines
should live in a focused module rather than enlarging an entry file. This is a design
signal, not a reason to fragment small cohesive functions.

## 4. Session behavior is isolated single-session behavior

The product rule is:

> Each session behaves exactly like the accepted single-session implementation;
> multiple sessions are independent instances that may run concurrently.

Therefore:

- Capture the target `sessionId` before the first asynchronous boundary. Never
  re-read the currently visible session to decide ownership later.
- An event for session A must not mutate, render, scroll, finalize, snapshot, or
  clean session B.
- Selecting a session changes visibility only. It must not reset, cancel, finalize,
  or rewrite that session.
- Background events update their owning session store and never the visible DOM of a
  different session.
- Main-assistant finality is authoritative. Once a generation is terminal, delayed
  events cannot make it active again.
- Append keeps the accepted single-session message identity and presentation rules;
  it is not a separate cross-session behavior.

Any session-sensitive state keyed only by a global variable is presumptively a bug.

## 5. Snapshot and history rules

- A snapshot is the authoritative persisted UI history for its recorded boundary.
- Load the snapshot first and preserve its exact visible message order and hidden
  state.
- Append only messages proven to be newer than the snapshot boundary. Do not merge
  arbitrary remote history into an existing snapshot.
- Remote presence does not imply UI visibility; users may intentionally hide or
  revert messages.
- Export failure must not prevent later local messages from being persisted.
- Active-turn presentation may be stored separately, but it must not silently become
  canonical finalized history.
- Never repair or rewrite an existing snapshot merely because remote history differs
  unless a specifically designed and proven repair path is being executed.

Snapshot changes require tests for reload equivalence, append continuity, and a
failed-export path.

## 6. Message identity and turn lifecycle

- Use canonical message IDs when available. Temporary IDs and aliases must have an
  explicit, monotonic handoff to the canonical ID.
- Do not infer identity from array position, text equality, DOM order, or whichever
  assistant message happens to be visible.
- A partial text update replaces or extends only the presentation owned by the same
  turn generation.
- Tool-only, todo-only, and subagent-only updates preserve the accepted assistant
  text until replacement text for that same generation arrives.
- Finalization must use the latest authoritative assistant content for the owning
  generation. It must not select an older temporary presentation or concatenate
  unrelated generations.
- Cancellation must clean the complete current turn range and restore the correct
  user draft according to the existing single-session contract.

Lifecycle transitions should be monotonic and idempotent. Receiving the same final,
idle, cancellation, or binding signal twice must not create another bubble or repeat
destructive cleanup.

## 7. Undo, restore, changelists, and files

- Undo and restore commands carry explicit session, operation, and canonical message
  ranges.
- UI visibility is not sufficient evidence for the real undo range.
- Restore succeeds only when both message restoration and actual workspace/Git
  restoration have been verified.
- Changelists stay anchored to their canonical message and timeline position.
- Nested reverted segments preserve canonical order when expanded or restored.
- Never change file rollback behavior as a side effect of fixing segment rendering.

These paths require targeted regression tests even when the change appears visual.

## 8. Rendering and virtualization boundaries

- Session/message state owns what exists. Virtualization owns only which portion is
  mounted, measurements, spacers, and scroll anchoring.
- A render optimization must not change message identity, order, lifecycle, hidden
  state, segment membership, or changelist ownership.
- Do not use a full DOM rebuild as a routine response to a local metadata update.
- Preserve the user's scroll intent. Automatic bottom following is allowed only when
  the accepted policy says the user is following the bottom or explicitly requested
  it.
- Image and rich-content measurements are asynchronous. Anchor corrections must be
  bounded, attributable to the current virtual transaction, and unable to replay
  after a newer user scroll or session selection.
- Prepare/commit/abort and recovery paths must be balanced. A stale transaction must
  not write presentation state after a newer transaction wins.

Avoid high-frequency logging inside scroll, resize, measurement, or SSE hot paths.
Diagnostics in hot paths must be sampled, coalesced, or emitted only on state changes.

## 9. Adding a feature

Use this sequence:

1. Write the user-visible contract and identify invariants that must not change.
2. Locate the canonical owner and existing protocol boundary.
3. Add a focused domain method or module.
4. Add the smallest protocol message necessary, with explicit identity fields.
5. Keep `SidebarProvider.ts` and `media/main.js` wiring thin.
6. Reuse existing session selection, hydration, rendering, and persistence paths
   instead of creating parallel versions.
7. Add focused tests before broad manual validation.

Do not add a feature by copying an existing lifecycle or session pipeline and
modifying the copy.

## 10. Fixing a bug

Do not patch repeated symptoms. Establish an evidence-backed event chain:

1. expected state transition;
2. actual event order;
3. canonical state before and after each event;
4. stale or incorrect writer;
5. why the normal guard did not reject it.

When practical, first add a regression test that fails for the observed reason. The
fix should change the owning transition or guard, not hide the result in the DOM.

For intermittent bugs, add structured, session-scoped diagnostics. Include the
relevant session, turn/generation, message identity, transition, and reason; never log
message contents or sensitive attachment data merely for convenience.

## 11. Tests and validation

Test at the narrowest useful level and add cross-boundary coverage where ownership
can be lost.

Minimum expectations:

- Pure planner/reducer change: unit tests for transitions and edge cases.
- Protocol/controller change: request routing and host-boundary tests.
- Session change: isolation, interleaving, stale-response, and switch-away/back tests.
- Turn change: temporary-to-canonical binding, append, final, cancellation, and
  duplicate/late-event tests as applicable.
- Snapshot change: reload equivalence and proven-suffix tests.
- Rendering/virtualization change: identity/order tests plus anchor/measurement tests.
- Undo/restore change: UI topology and actual file behavior tests.

Standard validation commands are:

```text
npm test -- --runInBand
npm run compile
npm run check:webview
npm run check:webview:determinism
```

Run focused Jest tests while developing, then run the gates proportional to the risk.
Do not claim success solely because TypeScript compiles. If a relevant gate cannot be
run, report exactly which gate and why.

For high-risk UI behavior, also perform the manual checklist in
`docs/modularization-architecture.md`.

## 12. Change discipline

- Inspect `git status` before editing. Existing changes and untracked files belong to
  the user unless proven otherwise.
- Keep diffs scoped. Do not reformat, rename, or reorganize unrelated code.
- Do not edit generated Webview bundles directly; modify their source and use the
  repository build scripts.
- Prefer explicit types and narrow interfaces at module boundaries. Avoid `any` in
  new domain code unless an external untyped payload is immediately validated.
- Comments should explain ownership, invariants, or non-obvious reasons, not restate
  syntax.
- Remove temporary diagnostics once the cause is proven, unless they are deliberately
  retained as low-volume operational evidence.
- Do not introduce a dependency when a small, tested local abstraction is sufficient.

Every completed code or documentation change must be committed once as a logical
unit. Stage only the files belonging to the current task. Use an imperative commit
subject that describes the outcome, such as `Add project coding rules` or
`Preserve final assistant identity across session switches`.

## 13. Definition of done

A change is complete only when:

- the behavior and non-goals are clear;
- there is still one canonical state owner;
- session and turn identities survive asynchronous boundaries;
- stale, duplicate, and late events are handled;
- snapshot, append, undo/restore, changelist, and virtualization invariants remain
  intact where relevant;
- focused regression tests pass;
- proportional build/test gates pass;
- the diff contains no unrelated user files;
- documentation is updated when an ownership boundary or invariant changes;
- the logical change is committed.
