# Slice 7 Wave 0 Append Ownership And Lifecycle Audit

Date: 2026-06-03

Scope: read-only source investigation plus this audit note. No production code or tests changed.

## 1. Append ingress map

### Webview sender

- `media/main.js:6819-6844` `submitAppendMessage(sessionId, rootUserKey, text)` is the only located webview `appendMessage` sender.
  - Captures `sessionId` and `rootUserKey` from `appendInputMode` via send button click at `media/main.js:7247-7257`.
  - Creates `clientMessageId = append-${Date.now()}-${messageCounter++}` at `media/main.js:6825`.
  - Writes optimistic root metadata via `upsertAppendItem(root, { clientMessageId, text, status: 'sending', createdAt })` at `media/main.js:6826-6831`.
  - Sends `{ type: 'appendMessage', sessionId, rootUserKey, clientMessageId, value }` at `media/main.js:6834-6840`.

### Extension handler

- `src/SidebarProvider.ts:2772-2851` handles `case "appendMessage"`.
  - `sessionId` is `data.sessionId` but falls back to `this.currentSessionId` at `src/SidebarProvider.ts:2773`. This is a Wave 1 ownership target: append ingress should require/capture payload session rather than fallback after switching.
  - `clientMessageId` is `data.clientMessageId` but falls back to `append-${Date.now()}` at `src/SidebarProvider.ts:2775`. This can lose the webview optimistic item join key if missing.
  - `requestedRootUserMsgId` is `data.rootUserKey` at `src/SidebarProvider.ts:2777`.
  - `currentRootUserMsgId` is `this.client.getAppendRootUserMsgId(sessionId) || requestedRootUserMsgId` at `src/SidebarProvider.ts:2778`; this means extension currently prefers client runtime root if present, otherwise payload root.
  - **Current session-switch bug:** append is rejected unless `this.currentSessionId` is set and equals `sessionId` at `src/SidebarProvider.ts:2790-2800`. This violates S7.I3 because a valid append for A can be rejected after the user switches visible session to B.
  - Begins runtime relation with `this.client.beginAppendPrompt(sessionId, clientMessageId, value)` at `src/SidebarProvider.ts:2812`.
  - Sends backend append via `this.client.appendPrompt(sessionId, value, { model: this.selectedModel, mode: this.selectedMode, clientMessageId })` at `src/SidebarProvider.ts:2826-2830`.
  - Sends `appendStatus` ack/reject/error with `sessionId`, `clientMessageId`, `rootUserMsgId` at `src/SidebarProvider.ts:2780-2787`, `2791-2798`, `2802-2809`, `2814-2820`, `2831-2837`, `2840-2847`.

## 2. Runtime append state map

### Webview session state

- `media/main.js:721-767` `createSessionState()` owns per-session fields:
  - `appendRootUserKey` (`media/main.js:753`): root user message key for current appendable turn.
  - `appendComposerFor` (`media/main.js:754`): transient composer/root marker.
  - `appendComposerDrafts` (`media/main.js:755`): per-root append draft map.
  - `inputDraft` (`media/main.js:756`): normal composer draft.
- `media/main.js:907-940` `captureVolatileHydrationState()` preserves `appendRootUserKey`, `appendComposerFor`, `appendComposerDrafts`, and `inputDraft` during hydration.
- `media/main.js:943-1090` `restoreVolatileHydrationState()` restores those fields, including `appendComposerDrafts` merge at `media/main.js:1065-1077`.
- `media/main.js:2428-2440` `replaceKeyEverywhere()` rewrites `lastTurnUserId`, `appendRootUserKey`, `appendComposerFor`, and `appendComposerDrafts` keys when local IDs upgrade.
- `media/main.js:4029-4079` append composer lifecycle:
  - `enterAppendInputMode()` stores normal draft and restores per-root append draft.
  - `exitAppendInputMode()` saves or discards per-root append draft.
- `media/main.js:4099-4107` `clearAppendInputForSessionChange(nextSessionId)` clears only global `appendInputMode` when switching away; draft should survive in per-session `appendComposerDrafts`.

### Webview append relation metadata

- `media/main.js:6745-6785` `upsertAppendItem(message, item)` stores/updates root `message.meta.appendedPrompts` entries.
  - Match key is `clientMessageId` or `appendUserMsgId` (`media/main.js:6751-6754`).
  - Entry fields observed: `clientMessageId`, `text`, `status`, `createdAt`, `appendUserMsgId`, `reason`.
- `media/main.js:6787-6817` `markAppendItemSeenByAssistantParent()` can promote earlier append items to `seen` based on assistant parent ID.
- `media/main.js:7154-7169` `handleChatDone()` finalizes unresolved appended prompts on root `session.appendRootUserKey || session.lastTurnUserId`, marking `seen`/queued items as `applied` and unacked items as failed.

### Extension/OpenCodeClient runtime state

- `src/OpenCodeClient.ts:446-457` defines `AppendPendingPrompt` and `AppendTurnState`:
  - `rootUserMsgId`
  - `pending: AppendPendingPrompt[]` with `{ clientMessageId, text, serverMsgId? }`
  - `appendUserMsgIds: Set<string>`
  - `emittedAppendUserMsgIds: Set<string>`
- `src/OpenCodeClient.ts:554` owns `appendTurnStateBySession`.
- `src/OpenCodeClient.ts:2337-2348` exposes root/latest identities:
  - `getAppendRootUserMsgId(sessionId)` returns append state root or `displayTurnUserMsgIdBySession`.
  - `getLatestAppendUserMsgId(sessionId)` returns last append child from `appendUserMsgIds`.
- `src/OpenCodeClient.ts:2356-2364` `canAppendToCurrentTurn(sessionId)` gates on target session turn state, display root, and final/cancel state.
- `src/OpenCodeClient.ts:2366-2380` `beginAppendPrompt()` creates/updates `appendTurnStateBySession`.
- `src/OpenCodeClient.ts:2395-2407` `bindAppendUserMessage()` binds first unbound pending prompt to backend `msg_*` append user ID.
- `src/OpenCodeClient.ts:2409-2423` `getAppendPromptForUserMessage()` and `shouldEmitAppendUserMessage()` control one-time append child emission.
- `src/OpenCodeClient.ts:6813-6821` binds append user message during SSE `message.updated` user ack and keeps current turn user anchored to root via `setCurrentTurnUserMsgId(sessionId, rootUserMsgId, 'append-root-user-message')`.
- `src/OpenCodeClient.ts:7034-7056` binds/handles text parts for append user messages and emits `appendUserMessage` with `sessionId`, `messageId`, `appendUserMsgId`, `rootUserMsgId`, and `clientMessageId`.

## 3. Cleanup and overwrite sites

### Too-early or unsafe cleanup targets

- `src/OpenCodeClient.ts:1919-1981` `finishTurn(sessionId)` deletes `appendTurnStateBySession` at `src/OpenCodeClient.ts:1971` after post-final setup. In current extension ordering this happens after commit/diff/snapshot in normal send (`src/SidebarProvider.ts:2678-2681`), but it still removes the relation before any late/deferred side effect or reload recovery can inspect it.
- `src/OpenCodeClient.ts:642-737` `resetSessionState()` clears all append state at `src/OpenCodeClient.ts:685`. Extension `resetSessionState()` calls this at `src/SidebarProvider.ts:7274-7292`.
- `src/SidebarProvider.ts:7294-7299` `resetUiState()` calls `resetSessionState()` and posts `resetUiState` to the webview. `selectSession` calls `resetUiState()` at `src/SidebarProvider.ts:3237`, so selecting another session while append is live can clear extension append runtime globally.
- `src/OpenCodeClient.ts:1804-1849` `startTurn()` deletes `appendTurnStateBySession` at `src/OpenCodeClient.ts:1814`; acceptable for a new non-append turn in the same session, but Wave 1 should confirm this is not called by append continuation itself.
- `src/OpenCodeClient.ts:1276-1335` `bootstrapContinuationTurn()` deletes append state at `src/OpenCodeClient.ts:1296`; continuation-specific cleanup, likely acceptable but should not fire for ordinary append.
- `src/OpenCodeClient.ts:1352-1359` / grep hit at `src/OpenCodeClient.ts:1365` failed continuation cleanup deletes append state; likely acceptable for failed continuation but should be classified explicitly in Wave 1.
- `src/OpenCodeClient.ts:2383-2392` `failAppendPrompt()` deletes the session append state only when no pending prompts and no bound append user IDs remain; this is acceptable failure cleanup.

### Allowed deletion

- True session deletion is extension-owned at `src/SidebarProvider.ts:3174-3217` and webview-observed at `media/main.js:7923-7943`. Current webview `sessionDeleted` removes the session from the list but does not delete `sessionsById` state; Wave 1 may add targeted append/runtime deletion only for the deleted session if needed.

### Hydration overwrite paths

- `media/main.js:7980-8349` `sessionData` clears `messagesById`, `timeline`, active turn flags, and hidden state at `media/main.js:8024-8045`, then restores captured volatile state at `media/main.js:8294-8317`. Append volatile fields are included in capture/restore, so current hydration already tries to preserve append composer/root state.
- Metadata from hydrated messages is copied as `item.meta || {}` at `media/main.js:8091-8096`, `8123-8128`, and `8187-8192`, so `meta.appendedPrompts` is not intentionally stripped in these paths.

## 4. Snapshot writers/readers and meta sanitization

- Extension snapshot payload construction:
  - `src/SidebarProvider.ts:1356-1427` `buildSnapshotSessionPayload()` canonicalizes and filters messages, preserving `sessionPayload.meta` at `src/SidebarProvider.ts:1421-1424`.
  - `src/SidebarProvider.ts:1439-1459` `normalizeSnapshotStoredMessages()` preserves normalized meta when present.
  - `src/SidebarProvider.ts:1461-1486` `normalizeSnapshotMessageMeta()` shallow-copies all meta and only sanitizes `images`; it does not strip `appendedPrompts`.
  - `src/SidebarProvider.ts:1488-1564` `appendSnapshotIncremental()` merges existing/incoming messages, then calls `normalizeSnapshotStoredMessages()` at `src/SidebarProvider.ts:1555`.
  - `src/SidebarProvider.ts:1582-1622` `writeFinalizeSnapshotFromCanonicalSession()` exports canonical session messages, filters to `msg_*` roles, and persists with `appendSnapshotIncremental()`.
- Snapshot/sessionData readers:
  - `src/SidebarProvider.ts:3296-3325` loads snapshot sessionData and forwards `snapPayload.meta` plus source.
  - `src/SidebarProvider.ts:3362-3383` merges recent export with snapshot via `computeRecentAppendCandidates()` and `enforceUserAssistantPairs()`.
  - `src/SidebarProvider.ts:4666-4694` has the same snapshot load shape for recent session bootstrap (found by static search; not fully re-read in this wave beyond grep context).
- Webview snapshot meta:
  - `media/main.js:7189-7211` `sanitizeMetaForSnapshot()` shallow-copies meta and sanitizes images only, so `appendedPrompts` survives if snapshot emission uses this path.
  - Legacy webview snapshot catch-up is disabled at `media/main.js:5715-5723`; normal finalize snapshots are extension-owned.

## 5. Finalization chain and ordering

### Normal send/finalize extension chain

- `src/SidebarProvider.ts:2645-2651`: posts `chatDone` and `turnFinalizePhase(stream_done)` for target session.
- `src/SidebarProvider.ts:2655-2660`: builds pre-commit identity and commits pending changes using authoritative files.
- `src/SidebarProvider.ts:2663-2669`: emits commit/upgrade finalize phases and resolves user upgrade.
- `src/SidebarProvider.ts:2672-2678`: builds final identity with `clientMessageId`, assistant ID, and commit result; emits diff/change-list with retry.
- `src/SidebarProvider.ts:2680-2681`: writes finalize snapshot, then calls `this.client.finishTurn(targetSessionId)`.
- `src/SidebarProvider.ts:2688-2690`: emits final logs and `turnFinalizePhase(finalize_done)`.

### Append-specific ack/final binding

- `src/OpenCodeClient.ts:6813-6821` and `src/OpenCodeClient.ts:7034-7056` bind append child user IDs from SSE and emit `appendUserMessage`.
- `media/main.js:8497-8517` handles `appendStatus`, resolving root by `resolveAppendRootMessage()` and updating `meta.appendedPrompts`.
- `media/main.js:8519-8535` handles `appendUserMessage`, adding `appendUserMsgId` and setting status `queued`.
- `media/main.js:8839-8863` handles `chatDone`; `handleChatDone()` at `media/main.js:7061-7187` binds final assistant and marks append items applied/failed.
- `media/main.js:8813-8836` handles `turnFinalizePhase(finalize_done)` by marking the target session finalized and render-gating by active session.

### Duplicate handler resolution

- `media/main.js` contains duplicate `case 'messageAppend'` labels at `media/main.js:9201-9242` and `media/main.js:9299-9327`.
- In this single JavaScript `switch`, the first matching case at `media/main.js:9201` is the reachable handler because it `break`s; the later duplicate is dead/unreachable for `message.type === 'messageAppend'` unless control flow is edited to fall through before it. Wave 1 should still update/delete the duplicate deliberately if touching this block, because earlier Slice 0 plan text required treating duplicate cases as ownership surface until proven unreachable.

## 6. Authoritative diff union inputs

- `src/SidebarProvider.ts:1896-1915` `buildFinalizeTurnIdentity()` collects:
  - `rootUserMessageId` from explicit partial, `client.getAppendRootUserMsgId(sessionId)`, or current turn user.
  - `latestAppendUserMessageId` from `client.getLatestAppendUserMsgId(sessionId)`.
  - `userMessageId` prefers latest append child, then root, then current turn user.
- `src/SidebarProvider.ts:1918-1941` `resolveAuthoritativeFilesForCommit()` asks `client.getAuthoritativeDiffFileSet({ sessionId, rootUserMessageId, latestAppendUserMessageId })` when either root/latest append ID is resolvable.
- `src/SidebarProvider.ts:1990-2017` `emitDiffFileList()` re-fetches authoritative files with the same root/latest append inputs and logs compare counts.
- `src/OpenCodeClient.ts:3294-3320` `getAuthoritativeDiffFileSet()` unions `info.summary.diffs` from unique `rootUserMessageId` and `latestAppendUserMessageId` via `GET /session/:id/message/:messageID` (`src/OpenCodeClient.ts:3250-3258`).
- **Current risk:** runtime can provide both IDs only while `appendTurnStateBySession` survives. `finishTurn()` deletes it at `src/OpenCodeClient.ts:1971`; normal chain computes commit/diff before deletion, but any deferred retry/recovery after `finishTurn()` loses `latestAppendUserMessageId` and can fall back to root/current only.

## Proposed Wave 1 edit targets

1. `src/SidebarProvider.ts:2772-2851` `appendMessage` handler:
   - Require/capture payload `sessionId`, `rootUserKey`, and `clientMessageId`.
   - Remove `this.currentSessionId` fallback and remove `sessionId !== this.currentSessionId` rejection.
   - Gate append by captured target session plus `sendInFlightBySession.has(sessionId)` and `client.canAppendToCurrentTurn(sessionId)`.
   - Add `[EXT][APPEND_ROUTE]` logs with session/root/client IDs and reject reasons.
2. `src/OpenCodeClient.ts:2366-2380` `beginAppendPrompt()`:
   - Accept/record the authoritative root from ingress when supplied, or validate it equals existing display/root state.
   - Retain root/client/latest child relation until all side effects are done.
3. `src/OpenCodeClient.ts:1919-1981` `finishTurn()` and `src/OpenCodeClient.ts:642-737` `resetSessionState()`:
   - Do not delete `appendTurnStateBySession` before final/change-list/commit-bind/snapshot completion is proven.
   - Avoid global append-state clearing on ordinary `selectSession`/`resetUiState`; reserve cleanup for true session deletion or explicit completed-retention cleanup.
4. `src/SidebarProvider.ts:3232-3480` `selectSession` / `resetUiState()` call path:
   - Stop clearing extension append runtime for unrelated sessions during session selection.
5. `media/main.js:8497-8535` `appendStatus` / `appendUserMessage`:
   - Replace direct `window.__oc.renderFromState()` / `scrollToBottom()` with `renderIfActive(sessionId, ...)` so background append ack/child updates do not redraw active B.
6. `media/main.js:9201-9242` and duplicate `media/main.js:9299-9327` `messageAppend` cases:
   - If touched, consolidate or delete the duplicate after proving first-case reachability; ensure metadata preservation if append child messages arrive through `messageAppend` rather than `appendUserMessage`.

## Blockers / ambiguities

- No Wave 0 stop-condition blocker found: append ingress has explicit session/root/client IDs, and duplicate `messageAppend` reachability is resolvable as first-case reachable in the current single switch.
- Remaining ambiguity for Wave 2/3, not blocking Wave 1: whether backend export always includes root `meta.appendedPrompts` after finalize. Current snapshot sanitizers preserve the field, but if export omits it, Wave 2 needs session-owned metadata merge rather than relying on exported message meta.
- Remaining risk for Wave 3: latest append child ID is durable only until `appendTurnStateBySession` is deleted; retention must land before relying on deferred authoritative root+child union.
