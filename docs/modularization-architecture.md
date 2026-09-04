# OpenCode GUI modularization architecture

This document describes the ownership boundaries on `refactor/modularize-large-files`.
The entry files remain compatibility/composition surfaces; extracted modules must not
create a second writer for their host state.

## Extension ownership

| Capability | Module owner | Entry responsibility |
| --- | --- | --- |
| Models, variants, quota | `src/models/ModelQuotaService.ts` | Construct service and forward results |
| Per-session model/reasoning/mode settings | `src/session-runtime/SessionSettingsStore.ts` | Route explicit session identity and provide persisted settings |
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
| Active chat model/reasoning/mode projection | `webview-src/features/models/*`, `media/main.js` |
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
