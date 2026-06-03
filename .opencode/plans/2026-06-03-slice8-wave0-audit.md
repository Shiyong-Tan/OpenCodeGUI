# Slice 8 Wave 0 Subagent Routing Audit

**Date:** 2026-06-03  
**Scope:** Read-only audit of `src/OpenCodeClient.ts`, `src/SidebarProvider.ts`, `media/main.js`; this note is the only intended file change.  
**Parent plan:** `.opencode/plans/2026-06-03-slice8-subagent-routing-wave.md` Wave 0.

## Executive findings

1. `agentSessionId` and `parentSessionId` are sometimes present but not authoritative end-to-end. Extension/webview payloads still frequently use `sessionId` as a collapsed owner.
2. Parent-visible subagent status/progress currently falls back to mutable `currentSessionId` in extension and `activeSessionId` in webview.
3. Agent-lane content is emitted mostly as normal `assistantMessageMeta` / `text` / `diff` / `files` with `sessionId = agentSessionId`; no `displayTarget` is present, so webview cannot distinguish agent-lane content from normal parent timeline content without re-inferring.
4. Stable pulse root mapping exists in `OpenCodeClient`, but only `backgroundActivityPulse` uses it. Status/progress/todos/final content do not consistently include both agent and parent owners.
5. Terminal/clear logic is currently global over all tracked subagents in several paths; it is not parent-scoped.

## Parent/agent association sources

| Source | Location | Current behavior | Reliability / risk |
|---|---:|---|---|
| `subagentToParentSessionMap` | `src/OpenCodeClient.ts:599`, `2174-2180` | Maps `subagentSessionId -> parentSessionId`; set by `registerSubagentSession`. | Authoritative when registered, but registration call site can use mutable parent. |
| `stablePulseRootSessionBySubagent` | `src/OpenCodeClient.ts:600`, `2177-2179`, `6681-6691` | First registration seeds stable root for pulse routing and does not overwrite later. | Good for pulse only; clear behavior does not remove it. |
| Sidebar subagent progress map | `src/SidebarProvider.ts:150-151`, `5722-5755`, `5795-5807` | Stores `{ taskId: agentSessionId, parentSessionId: this.currentSessionId || '' }`. | Risk: parent captured from mutable `currentSessionId`, including non-inflight fallback branch. |
| Lane classification | `src/OpenCodeClient.ts:6548-6553` | `subagent` if session is in map, `main` if `sessionId === currentSessionId || turnStateBySession.has(sessionId)`. | Risk: `currentSessionId` still participates in ownership/lane inference. |
| Backend payload | `src/OpenCodeClient.ts:6540-6584`, `6802-7247` | `sessionID` extracted from `message.updated`, `message.part.updated`, `session.status/diff/error`. | Provides event session/agent ID, but not parent ID for subagent events. |
| Webview route helper | `media/main.js:1304-1332` | Resolves only `sessionId/sessionID/part.sessionID`; returns `{ sessionId, source, isActive, shouldRender }`. | No parent/agent/display target concept. |

## Extension event surfaces and current emitted fields

| Event / surface | Source function/case | Current fields sent | Desired target | Current fallback / risk | Wave 1 edit target |
|---|---:|---|---|---|---|
| `subagentStatus` | `SidebarProvider.emitSubagentStatus`, `src/SidebarProvider.ts:389-412` | `type`, `active`, `agents[]` with `sessionId` (agent) and `parentSessionId`, counts, top-level `sessionId: this.currentSessionId` | Parent-visible, keyed by `parentSessionId` | Top-level `sessionId` is mutable current parent, not per-agent parent; webview uses it as bucket. | Add `displayTarget:'parent'`; either emit per parent or include authoritative `parentSessionId` top-level; remove `currentSessionId` fallback; log/drop ambiguous mixed-parent list. |
| `subagentStateDelta` | `SidebarProvider.emitSubagentStateDelta`, `src/SidebarProvider.ts:433-449` | `sessionId: this.currentSessionId`, `parentSessionId: entry.parentSessionId || this.currentSessionId`, `agentSessionId` | Parent-visible state delta keyed by `parentSessionId` | Falls back to `currentSessionId`; top-level `sessionId` is wrong if user switched. | Set `sessionId` to parent only if proven; require `entry.parentSessionId`; add `displayTarget:'parent'`; drop/log missing parent. |
| Subagent registration | `SidebarProvider.handleChatEvent` session branch, `src/SidebarProvider.ts:5721-5755` | Calls `client.registerSubagentSession(event.sessionId, this.currentSessionId || '')`; progress parent also `this.currentSessionId || ''`. | Authoritative mapping `{agentSessionId -> parentSessionId}` captured at parent turn ingress. | Uses mutable `currentSessionId`; async `getSessionInfo().then` later emits status using stored entry but entry may already be wrong. | Capture owner parent from send-in-flight owner, stable map, or explicit payload; never default to current after async boundary. |
| Non-owned subagent session branch | `src/SidebarProvider.ts:5773-5807` | Adds active subagent and progress entry, parent `this.currentSessionId || ''`; does **not** call `registerSubagentSession`. | Either register with proven parent or drop. | Creates entries with possibly wrong/empty parent; later events considered subagent by Sidebar set but not OpenCode map. | Require proven parent before creating subagent progress; add route/drop log. |
| Subagent text/tool/toolPatch/diff progress | `src/SidebarProvider.ts:5858-5925` | Updates progress entry and emits status; no payload parent beyond status. | Parent-visible progress under stored parent. | Depends on prior stored parent; no drop if entry parent missing. | Validate `entry.parentSessionId`; emit status with parent; log/drop missing. |
| Subagent files/progress + diff side effects | `src/SidebarProvider.ts:5927-5966` | Uses `this.currentSessionId` for `queueSubagentChanges`, `segmentRestoreLock`, diff open, plan card anchor/session. | Parent-visible side effects keyed by parent. | High risk: all side effects use mutable current session, not `entry.parentSessionId`. | Replace with `entry.parentSessionId`; drop/log if missing; pass `agentSessionId` and `displayTarget`. |
| Subagent final accepted | `src/SidebarProvider.ts:5972-5981`; `OpenCodeClient.ts:6982-7012` | `assistantMessageMeta` carries only `sessionId` (= agent session), `assistantMsgId`, `messageId`, `messageIndex`, `tmpKey`. Sidebar marks progress done. | Agent-lane final content keyed by agent; parent-visible done delta keyed by parent. | Agent final may be handled as normal assistant meta; no display target. | Add `parentSessionId` and `displayTarget:'agent-lane'` to agent-lane content or document explicit promotion. |
| `backgroundActivityPulse` | `OpenCodeClient.mapServerEventToChatEvents`, `src/OpenCodeClient.ts:6701-6709`; `resolveBackgroundPulseTarget`, `6681-6691`; Sidebar relay `6080-6088` | `sessionId` = stable root/parent when known, `assistantMsgId`, `ts`; no agent ID. | Parent-visible pulse keyed by parent. | Fallback to `sessionId` if no root mapping; missing `agentSessionId` makes diagnosis hard. | Add `parentSessionId`, `agentSessionId`, `displayTarget:'parent'`; drop/log if subagent lacks parent map instead of falling to agent/current. |
| `todoUpdate` | `OpenCodeClient.ts:7241-7247`; Sidebar relay `5661-5668` | Only relayed for `this.isUserOwnedSession(event.sessionId || '')`; sends `sessionId`, `todos`, `anchorMessageId`. | Parent-visible for subagent todos, parent session; main todos stay main. | Subagent todo updates are likely dropped because agent session is not user-owned; no parent mapping use. | For subagent session, map to parent and include `agentSessionId`; main route unchanged. |
| Agent-lane text chunks | `OpenCodeClient.ts:7182`; Sidebar relay `6132-6149` | `text` event sessionId=agent; Sidebar posts `assistantMessageMeta` with `sessionId`, `lastText`, tmpKey, allowedSessionIds. | Agent-lane content keyed by agent. | No `displayTarget`; allowedSessionIds is derived from current session via `getAssistantMetaAllowedSessionIds` (`6342-6352`), which uses `currentSessionId`. | Include explicit `agentSessionId`, `parentSessionId`, `displayTarget:'agent-lane'`; avoid current-session allowed-list fallback for subagent. |
| Diff/files/toolPatch | `OpenCodeClient.ts:7253-7359`; Sidebar relays `6253-6275`, subagent intercept `5897-5966` | `sessionId`=event session (agent for subagent) in normal path; subagent intercept also creates parent side effects using current. | Agent-lane content stays in agent; parent-visible file/change indicators use parent. | Mixed semantics and current-session side effects. | Split parent-visible side effects from agent-lane events; add displayTarget and parent/agent IDs. |
| `assistantPhase` | Sidebar relay `5671-5679`; OpenCodeClient emits via `emitAssistantPhase` (called `6936-7002`) | `sessionId`, `messageId`, `parentId`, `lane`, `phase`, `reason`, `ts`. | Agent-lane phase for subagent; parent-visible only if summary semantic exists. | Webview uses `getEventSessionId` and mutates target session meta; no parent association. | Add parent/agent/display target for subagent phase, or keep agent-lane only with explicit target. |

## Webview handlers and state buckets

| Handler | Location | Current bucket mutation | Current render / clear behavior | Fallback/drop risk | Wave target |
|---|---:|---|---|---|---|
| `subagentStatus` | `media/main.js:8058-8104` | `getSessionState(sessionId || activeSessionId)`; writes `sess.activeSubagents`; writes current thinking message `meta.subagents`. | Updates global `#subagent-indicator`; calls `scheduleRenderFromState()` unconditionally. | Falls to `activeSessionId`; top-level extension `sessionId` is current session. Background parent events can render active DOM. | Wave 2: route by `parentSessionId`; group agents per parent; render only if parent active; drop missing parent. |
| `subagentStateDelta` | `media/main.js:8113-8127` | `getSessionState(message.sessionId || activeSessionId)`; updates matching `activeSubagents` by `agentSessionId`. | Calls `scheduleRenderFromState()` unconditionally. | Falls to active session; ignores `parentSessionId` even when present. | Wave 2: resolve parent route from `parentSessionId`; no active fallback; render-if-active. |
| `backgroundActivityPulse` | `media/main.js:8106-8111` | Uses `getEventSessionId` then `armBackgroundSubagentIndicator(sessionId, assistantMsgId)`. Indicator fields are session-scoped. | `requestBackgroundPulseRender()` renders globally even for background session (`1114-1124`, `1215-1240`). | Drops missing session via generic helper; if extension falls back to agent/current, webview trusts it. | Wave 2: route parent-visible pulse by `parentSessionId`; only render active parent, otherwise state-only. |
| `todoUpdate` | `media/main.js:9467-9487` | Generic session resolver; writes `msg.meta.todos` on session thinking/current assistant. | `renderIfActive(sessionId, 'todoUpdate')`. | If subagent todo is emitted with agent `sessionId`, it mutates agent bucket rather than parent thinking card; extension currently drops subagent todos. | Wave 2/1: extension maps subagent todos to parent; webview uses parent route and agent metadata. |
| `assistantMessageMeta` | `media/main.js:8979-9046` | Generic session resolver; `handleAssistantMeta(sessionId, ...)`. | `renderIfActive`; allowed-list gate uses payload `allowedSessionIds`. | Agent-lane final/text is treated like normal session content; no display target. | Wave 3: distinguish `displayTarget:'agent-lane'`; prevent implicit parent/active timeline promotion. |
| `chatChunk` | `media/main.js:9077-9099` | Generic session resolver; `handleChatChunk(sessionId, message)`. | `renderIfActive`. | Safe for main if sessionId present; ambiguous for agent-lane subagent content without display target. | Wave 3: ensure subagent chunks use agent lane and parent association. |
| `chatDone` | `media/main.js:9127-9151` | Generic session resolver; `handleChatDone`; clears busy for target. | `renderIfActive`; `clearBusyForSession`. | If agent-lane done is sent as parent or active fallback, terminal side effects wrong. | Wave 3/4: classify subagent terminal separately from parent/global. |
| `addResponse` | `media/main.js:9290-9331` | `getEventSessionId`; upserts system message, `handleChatDone`. | Renders globally via `window.__oc.renderFromState()`, scrolls, `setBusy(false)` globally. | Existing global render/busy side effects; not subagent-specific but terminal-like if used by subagent error. | Wave 4 or separate: gate by active session for subagent/owned errors. |
| Duplicate `diffChunk` / `messageAppend` | `media/main.js:9371-9386`, `9489-9530`, `9570-9585`, `9587+` | Generic session resolver; mutates target session. | `renderIfActive`. | Both duplicates must be updated if agent-lane displayTarget logic touches them. | Wave 3: update both live duplicate cases or prove/delete unreachable. |

## Fallback/drop risks to remove

- `src/SidebarProvider.ts:411`: `subagentStatus` top-level `sessionId: this.currentSessionId`.
- `src/SidebarProvider.ts:438-440`: `subagentStateDelta` top-level `sessionId: this.currentSessionId`; parent fallback `entry?.parentSessionId || this.currentSessionId`.
- `src/SidebarProvider.ts:5721-5724`, `5743-5755`: registering/recording subagent parent from `this.currentSessionId` during send-in-flight branch.
- `src/SidebarProvider.ts:5773-5807`: non-user-owned subagent branch records `parentSessionId: this.currentSessionId || ''` and does not register OpenCodeClient parent map.
- `src/SidebarProvider.ts:5927-5966`: subagent `files` path queues changes, opens diffs, locks segments, and emits plan cards against `this.currentSessionId`.
- `src/SidebarProvider.ts:6091-6149`, `6214-6218`, `6253-6275`: generic assistant/text/message/files fallbacks use `event.sessionId || this.currentSessionId`; subagent agent-lane payloads are not self-describing.
- `src/OpenCodeClient.ts:6550-6552`, `6894-6895`: lane classification uses `currentSessionId` to call a session `main`.
- `src/OpenCodeClient.ts:6681-6684`: pulse target falls back to input `sessionId` when stable/root map missing.
- `media/main.js:8058-8061`: `subagentStatus` uses `sessionId || activeSessionId`.
- `media/main.js:8113-8114`: `subagentStateDelta` uses `message.sessionId || activeSessionId`.
- `media/main.js:9290-9330`, `9344-9355`: `addResponse`/`attachmentError` route by session but render globally; risk if used for background/subagent events.

## Terminal and clear classification

| Operation | Location | Current scope | Desired classification |
|---|---:|---|---|
| `clearSubagentSessions()` retention sweep | `src/SidebarProvider.ts:202-221`, scheduled `413-430` | Clears all expired entries; calls `client.clearSubagentSession(agent)` per entry. | Parent-scoped retention should remove only entries for target parent when invoked by parent lifecycle; retention sweep may remain global if explicitly named/logged. |
| `markAllSubagentsTerminal()` | `src/SidebarProvider.ts:452-463` | Marks all tracked subagents terminal. | Parent-scoped for send finalize/error/cancel. |
| Main finalize cancel active subagents | `src/SidebarProvider.ts:2809-2813` | Marks all active subagents cancelled and clears all. | Parent-scoped to `targetSessionId`. |
| Send error path | `src/SidebarProvider.ts:2877-2880` | Marks all failed and clears all. | Parent-scoped to captured `sessionId`. |
| User cancel path | `src/SidebarProvider.ts:4027-4029` | Marks all cancelled and clears all. | Parent-scoped to `cancelSessionId`. |
| Event error finalize | `src/SidebarProvider.ts:6164-6168` | Marks all failed and clears all. | Parent-scoped to event `sessionId`; global only if explicit shutdown/reset. |
| Client `clearSubagentSession` / `clearSubagentsForParent` | `src/OpenCodeClient.ts:2187-2213` | Can clear individual agent or all for parent; only deletes `subagentToParentSessionMap`, not stable pulse map. | Good primitive, but Wave 4 should verify stable pulse map lifecycle and logs. |
| Webview `clearBackgroundSubagentIndicator` | `media/main.js:1243-1252`, called by `cancelLocalTurn` `1254-1258` | Session-scoped when caller passes session. | Parent-scoped OK if caller target session is proven. |

## Minimal Wave 1 edit targets

1. **`src/SidebarProvider.ts` subagent parent capture and payloads**
   - `emitSubagentStatus` (`389-412`): stop top-level `sessionId: currentSessionId`; emit parent-scoped payload(s) with `parentSessionId`, `agentSessionId`, `displayTarget:'parent'`, and route/drop logs.
   - `emitSubagentStateDelta` (`433-449`): require `entry.parentSessionId`, set `sessionId` to parent only if proven, include `displayTarget:'parent'`, log/drop missing.
   - Session registration branches (`5711-5821`): replace current-session parent capture with a proven parent owner; register every accepted subagent or drop if parent unknown.
   - Subagent event intercept (`5858-5981`): validate `entry.parentSessionId` before status/progress/final state changes; for files path (`5927-5966`) use parent from entry rather than `currentSessionId`.

2. **`src/OpenCodeClient.ts` route metadata for subagent emissions**
   - Mapping APIs (`2174-2213`): add logs with `[EXT][SUBAGENT_ROUTE]`; do not overwrite stable root; consider whether clear should remove stable pulse map only on named parent/global reset.
   - `resolveBackgroundPulseTarget` / pulse emission (`6681-6709`): include both `parentSessionId` and `agentSessionId`; log/drop subagent pulse with missing root map rather than fallback to agent/current.
   - `todoUpdate`, text/tool/final/meta emissions (`7182`, `7214-7247`, `6991-7012`): include `parentSessionId`, `agentSessionId`, and `displayTarget` for subagent lane vs parent-visible status.
   - `classifyEventLane` (`6548-6553`): avoid `currentSessionId` as ownership proof after async event normalization.

3. **Do not start Wave 2 until Wave 1 makes payloads self-describing.** Webview needs unambiguous `parentSessionId` / `agentSessionId` / `displayTarget` before safe routing changes.

## Blockers / ambiguity

- No implementation blocker for Wave 0.
- Wave 1 has one design decision: for agent-lane final/message content (`assistantMessageMeta`, `text`, `chatChunk`-equivalent paths), confirm that content must remain in the agent lane and not be promoted to the parent timeline except for existing explicit summaries. Current code does not expose an explicit promotion marker.
- Parent association for the non-user-owned session branch (`src/SidebarProvider.ts:5773-5807`) cannot be proven from the code read here if no send-in-flight parent exists. Recommended behavior: route drop with `[EXT][SUBAGENT_ROUTE] reason=missing-parent` unless researcher/product provides another authoritative backend field.

## Validation hooks for later waves

- Extension grep: `rg -n "SUBAGENT_ROUTE|parentSessionId|agentSessionId|displayTarget|subagentToParentSessionMap|currentSessionId" src/OpenCodeClient.ts src/SidebarProvider.ts`
- Webview grep: `rg -n "SUBAGENT_ROUTE|SESSION_ROUTE_DROP|parentSessionId|agentSessionId|displayTarget|activeSessionId|currentSessionId" media/main.js`
- Manual S8.V1: A active, B parent receives C subagent status/progress/todos/pulse; B state mutates and A DOM/send gate is unchanged.
- Manual S8.V2: C final/message content while B background stays in C agent lane; switching to B shows expected parent UI and agent lane without A pollution.
- Manual S8.V3: Parent B terminal/clear does not clear parent A/D subagents.

## Wave 0 handoff block

- **Changed files:** `.opencode/plans/2026-06-03-slice8-wave0-audit.md` only.
- **Commands run:** see final coder handoff for exact command output.
- **Observed output:** audit found active/current-session fallback risks in extension parent capture, webview subagent handlers, and global subagent terminal/clear paths.
- **Open risks / next step:** researcher should accept the audit, resolve agent-lane promotion ambiguity if needed, then dispatch Wave 1 extension payload and mapping ownership only.
