# Slice 8 Subagent Routing And Parent Mapping Wave Plan

**Date:** 2026-06-03  
**Parent plan:** `.opencode/plans/ACTIVE_CHAT_SESSION_SWITCH_WORKFLOW.md` Slice 8  
**Prior accepted slice:** Slice 7 committed as `c2bb3f1 Fix append isolation and commit binding`  
**Risk level:** High — event routing, session isolation, render gating, terminal/clear scoping.  
**Execution rule:** Execute one bounded implementation wave at a time. After each implementation wave, stop for actual-diff review and route to `verifier` before starting the next dependent wave.

**Completion note:** Waves 0-5 were executed. Wave 1 extension payload ownership, Wave 2 WebView parent-visible routing, Wave 3 agent-lane preservation, and Wave 4 parent-scoped terminal/clear behavior were verifier-accepted. Wave 5 machine checks passed for `node --check media/main.js` and compile; unrelated continuation current-owner/snapshot focused tests remain deferred outside Slice 8. Manual log validation on `OpenCode-UI-Debug.log` found no Slice 8 route leakage; observed `unknown-session-parent` drops were conservative designed drops.

## Objective

Subagent status/progress/todos/pulse and agent-lane message/final content must be routed by authoritative `parentSessionId` and `agentSessionId`, never by mutable `currentSessionId` / `activeSessionId` after an event or operation has crossed an async boundary.

## Non-Negotiable Invariants

- [ ] S8.INV1 `agentSessionId` and `parentSessionId` remain distinct identifiers. Do not substitute one for the other except through an explicitly documented existing promotion/summary semantic.
- [ ] S8.INV2 Parent-visible events — subagent status, progress, todos, pulse, terminal summaries, and parent-facing lifecycle state — mutate the parent session state keyed by `parentSessionId`.
- [ ] S8.INV3 Agent-lane content — subagent chat/message/final content for the agent session — stays in the agent lane keyed by `agentSessionId` unless an existing product semantic explicitly promotes a summary to the parent.
- [ ] S8.INV4 Render gating is parent-aware: parent-visible updates render only when `parentSessionId === activeSessionId`; background parent updates mutate stored state without changing the active DOM, scroll, send gate, or overlays.
- [ ] S8.INV5 Agent-lane render gating is lane-aware: agent-lane content renders only in the intended lane/view, not in the current parent session because the user has switched sessions.
- [ ] S8.INV6 Missing, unknown, or contradictory parent/agent mapping is a route drop with grep-friendly logs, not a fallback to mutable current session.
- [ ] S8.INV7 Terminal/clear operations scope by `parentSessionId`; global clears are reserved only for named shutdown/reset paths and must be logged as global by intent.
- [ ] S8.INV8 Stable pulse root mappings must not be overwritten by later mutable selection. Once a pulse root maps `{ agentSessionId -> parentSessionId }`, later events may confirm it but must not silently retarget it to the active session.
- [ ] S8.INV9 Extension payloads that are ambiguous must carry both `parentSessionId` and `agentSessionId` plus `displayTarget` / equivalent routing intent before the webview handles them.

## Files In Scope For Slice 8

- `src/OpenCodeClient.ts`
- `src/SidebarProvider.ts`
- `media/main.js`

## Files Intentionally Out Of Scope

- `tests/` untracked temporary directory; do not clean, commit, or depend on it unless `researcher` explicitly approves.
- Snapshot/undo/append/git/change-list rewrites except where a subagent routing payload directly touches existing display state.
- Broad UI redesign of agent lanes or parent summary semantics.
- Production code outside the three Slice 8 files unless Wave 0 proves a required direct dependency and `researcher` approves a plan amendment.

## Target Logs

- [ ] S8.LOG1 Extension route/drop logs use `[EXT][SUBAGENT_ROUTE]` and include `event`, `parentSessionId`, `agentSessionId`, `displayTarget`, `source`, and drop reason when applicable.
- [ ] S8.LOG2 Webview route/drop logs use `[WV][SUBAGENT_ROUTE]` / `[WV][SESSION_ROUTE_DROP]` and include `event`, `parentSessionId`, `agentSessionId`, `displayTarget`, `isActiveParent`, and render decision.
- [ ] S8.LOG3 Terminal/clear logs include whether operation is `parent-scoped` or named `global-shutdown` / `global-reset`.

## Wave 0 — Read-Only Routing Audit

**Recommended first bounded wave.** Exact routing surfaces are not yet confirmed, so implementation must begin with audit evidence.

### Scope

- **Files in scope:** `src/OpenCodeClient.ts`, `src/SidebarProvider.ts`, `media/main.js`.
- **Files out of scope:** all other production files, `tests/` temp directory.

### Behavior Changed

- None. Read-only audit only.

### Tasks

- [ ] S8.W0.T1 Grep and map all subagent surfaces: `subagentToParentSessionMap`, pulse root maps, agent lane classification, `parentSessionId`, `agentSessionId`, `displayTarget`, `subagent`, `pulse`, `todo`, `terminal`, `clear`, and any route/drop logs.
- [ ] S8.W0.T2 For each extension emission in `OpenCodeClient.ts` and `SidebarProvider.ts`, classify event as parent-visible, agent-lane, global lifecycle, or ambiguous.
- [ ] S8.W0.T3 For each webview handler in `media/main.js`, record current owner fields, fallback behavior, mutation target, render target, and clear/terminal scope.
- [ ] S8.W0.T4 Identify async boundaries where `currentSessionId`, `activeSessionId`, or lane classification could be re-read after authoritative parent/agent IDs should already be captured.
- [ ] S8.W0.T5 Produce an audit table in the handoff: event name, source file/function, owner fields present, desired target, current fallback, required code change, validation hook.
- [ ] S8.W0.T6 Mark blockers: any event where parent/agent ownership cannot be proven from existing backend payloads or stable maps.

### Acceptance Criteria

- [ ] S8.W0.A1 Audit explicitly covers Slice 8 tasks S8.T1-S8.T5.
- [ ] S8.W0.A2 Audit identifies the minimal first implementation target with exact functions/handlers and no speculative broad rewrite.
- [ ] S8.W0.A3 Missing or unknown ownership cases are documented as drop-or-block decisions, not active-session fallbacks.

### Machine Validation Commands

- [ ] S8.W0.M1 `git status --short`
- [ ] S8.W0.M2 `rg -n "subagentToParentSessionMap|parentSessionId|agentSessionId|displayTarget|subagent|pulse|terminal|clear" src/OpenCodeClient.ts src/SidebarProvider.ts media/main.js`
- [ ] S8.W0.M3 `rg -n "currentSessionId|activeSessionId|classifyEventLane|stable.*pulse|pulse.*root|todoUpdate|SUBAGENT_ROUTE|SESSION_ROUTE_DROP" src/OpenCodeClient.ts src/SidebarProvider.ts media/main.js`

### Manual Validation

- [ ] S8.W0.U1 No UI/manual scenario required; this is read-only. Confirm audit table is sufficient for coder to implement Wave 1 without rediscovery.

### Rollback Boundary

- [ ] S8.W0.R1 No rollback needed; no production code changes. If audit notes are saved separately, they may be removed without affecting code.

### Stop Conditions

- [ ] S8.W0.S1 Stop if parent/agent association cannot be proven for any parent-visible event; request `researcher` decision on drop behavior or backend support.
- [ ] S8.W0.S2 Stop if agent-lane content semantics are unclear; request product/semantic confirmation before changing promotion behavior.
- [ ] S8.W0.S3 Stop if required changes extend beyond the three Slice 8 files; amend plan before implementation.

### Specialist Handoff

- [ ] S8.W0.H1 `explorer` or `coder` may perform this read-only audit; return handoff block: changed files, commands run, observed output, open risks / next step.
- [ ] S8.W0.H2 `researcher` should accept the audit before dispatching Wave 1.

## Wave 1 — Extension Payload And Mapping Ownership

### Scope

- **Files in scope:** `src/OpenCodeClient.ts`, `src/SidebarProvider.ts`.
- **Files out of scope:** `media/main.js` render behavior except for audit references; unrelated send/finalize/append/undo paths.

### Behavior Changed

- Extension-side subagent emissions carry authoritative routing fields: `parentSessionId`, `agentSessionId`, and `displayTarget` / equivalent route intent when ambiguous.
- Parent association is captured from stable source maps or payload evidence, not from mutable `currentSessionId` after async boundaries.
- Missing or contradictory parent/agent evidence drops or logs as blocked rather than retargeting to the current session.

### Tasks

- [ ] S8.W1.T1 Update subagent parent mapping logic so `subagentToParentSessionMap` and stable pulse root mappings are authoritative and do not silently retarget from `currentSessionId`.
- [ ] S8.W1.T2 Ensure each parent-visible extension message includes `parentSessionId`, `agentSessionId` when known, and a clear `displayTarget: 'parent'` or equivalent.
- [ ] S8.W1.T3 Ensure each agent-lane extension message includes `agentSessionId`, `parentSessionId` when known, and `displayTarget: 'agent-lane'` or equivalent.
- [ ] S8.W1.T4 Add extension route/drop logs for missing, unknown, or contradictory parent/agent IDs.
- [ ] S8.W1.T5 Remove active/current-session fallback from subagent async continuation routing unless Wave 0 identifies a safe command-ingress-only case.

### Acceptance Criteria

- [ ] S8.W1.A1 Extension payloads are self-describing enough for webview routing without re-inferring parent from active session.
- [ ] S8.W1.A2 `currentSessionId` remains allowed only as command-ingress/bootstrap context before ownership is captured, not as subagent event ownership after async boundaries.
- [ ] S8.W1.A3 Logs make drops diagnosable without leaking events into the wrong session.

### Machine Validation Commands

- [ ] S8.W1.M1 `npm run compile`
- [ ] S8.W1.M2 `npm test -- --runInBand` if existing tests are stable; if not, record failing suites unrelated to Slice 8.
- [ ] S8.W1.M3 `rg -n "SUBAGENT_ROUTE|parentSessionId|agentSessionId|displayTarget|subagentToParentSessionMap|currentSessionId" src/OpenCodeClient.ts src/SidebarProvider.ts`

### Manual Validation

- [ ] S8.W1.U1 Capture logs for a parent B subagent C event while A is active; extension log shows `parentSessionId=B`, `agentSessionId=C`, and no retarget to A.

### Rollback Boundary

- [ ] S8.W1.R1 Revert only `src/OpenCodeClient.ts` and `src/SidebarProvider.ts` changes from this wave if compile or route logging fails.

### Stop Conditions

- [ ] S8.W1.S1 Stop if backend payload lacks any way to establish parent/agent identity and no stable map exists.
- [ ] S8.W1.S2 Stop if adding `displayTarget` requires changing external API contracts beyond extension/webview internals.
- [ ] S8.W1.S3 Stop if compile failures require unrelated refactors.

### Handoff And Gate

- [ ] S8.W1.H1 Coder handoff block must list changed files, commands run, observed output, open risks / next step.
- [ ] S8.W1.H2 Route the actual diff to `verifier` before Wave 2 begins.

## Wave 2 — Webview Parent-Visible Routing And Render Gating

### Scope

- **Files in scope:** `media/main.js`.
- **Files out of scope:** extension payload construction except where a missing payload field forces a stop and plan amendment.

### Behavior Changed

- Parent-visible subagent status/progress/todos/pulse mutates state for `parentSessionId`.
- Parent-visible updates render only when the parent session is active.
- Missing or unknown parent mapping drops with logs instead of mutating/rendering the active session.

### Tasks

- [ ] S8.W2.T1 Add or update a webview subagent route resolver that returns `{ parentSessionId, agentSessionId, displayTarget, isActiveParent, shouldRender }` or a drop reason.
- [ ] S8.W2.T2 Route status/progress/todo/pulse parent-visible mutations to the parent session store keyed by `parentSessionId`.
- [ ] S8.W2.T3 Gate DOM redraws, scroll, overlays, pulse indicators, terminal summaries, and send-gate side effects by active parent session.
- [ ] S8.W2.T4 Preserve background parent state so switching to parent B later shows its subagent updates.
- [ ] S8.W2.T5 Add `[WV][SUBAGENT_ROUTE]` and drop logs with event, parent, agent, display target, and render decision.

### Acceptance Criteria

- [ ] S8.W2.A1 A active, B parent receives subagent C status/progress/todos/pulse: B state mutates, A DOM/send gate is unchanged.
- [ ] S8.W2.A2 Switching to B after background updates shows expected parent-visible subagent status/progress/todos/pulse.
- [ ] S8.W2.A3 Missing parent ownership is dropped or blocked; no fallback to active session.

### Machine Validation Commands

- [ ] S8.W2.M1 `node --check media/main.js`
- [ ] S8.W2.M2 `npm run compile`
- [ ] S8.W2.M3 `rg -n "SUBAGENT_ROUTE|SESSION_ROUTE_DROP|parentSessionId|agentSessionId|displayTarget|activeSessionId|currentSessionId" media/main.js`

### Manual Validation

- [ ] S8.W2.U1 Slice validation S8.V1: A active, B parent has subagent C update; B state changes, A DOM/send gate unchanged.
- [ ] S8.W2.U2 Partial S8.V2: C emits todo/progress/pulse while B background; switching to B shows parent UI state.

### Rollback Boundary

- [ ] S8.W2.R1 Revert only `media/main.js` changes from Wave 2 if route resolver or render gating regresses active session rendering.

### Stop Conditions

- [ ] S8.W2.S1 Stop if parent-visible state storage is not session-scoped and would require broad state model rewrite.
- [ ] S8.W2.S2 Stop if duplicate switch cases or handlers make it impossible to update all live routes confidently.
- [ ] S8.W2.S3 Stop if manual validation shows A DOM changes from B/C events.

### Handoff And Gate

- [ ] S8.W2.H1 Coder handoff block must list changed files, commands run, observed output, open risks / next step.
- [ ] S8.W2.H2 Route the actual diff to `verifier` before Wave 3 begins.

## Wave 3 — Agent-Lane Content Preservation

### Scope

- **Files in scope:** `media/main.js`; `src/OpenCodeClient.ts` / `src/SidebarProvider.ts` only if Wave 0/1 identified missing agent-lane payload fields.
- **Files out of scope:** new product semantics for summarizing/promoting agent content.

### Behavior Changed

- Agent-lane message/final content is keyed by `agentSessionId` and does not become parent timeline content unless an existing explicit summary/promotion path says so.
- Parent B can show expected agent-lane state for agent C after background C emissions without polluting active parent A.

### Tasks

- [ ] S8.W3.T1 Identify existing agent-lane message/final handlers and distinguish them from parent-visible status/progress handlers.
- [ ] S8.W3.T2 Ensure agent-lane mutations are keyed by `agentSessionId`, with parent association retained for lane lookup/navigation.
- [ ] S8.W3.T3 Gate rendering so active parent/session selection does not cause C final content to render into A or B parent timeline unless existing explicit promotion handles it.
- [ ] S8.W3.T4 Preserve existing summary/promotion semantics exactly; document any explicit promotion path in the handoff.

### Acceptance Criteria

- [ ] S8.W3.A1 C emits final/message content while B is background; A remains unchanged.
- [ ] S8.W3.A2 Switching to B shows B parent-visible state and the C agent lane content in the expected lane/location.
- [ ] S8.W3.A3 No new implicit promotion of C final content to parent B or active A is introduced.

### Machine Validation Commands

- [ ] S8.W3.M1 `node --check media/main.js`
- [ ] S8.W3.M2 `npm run compile`
- [ ] S8.W3.M3 `rg -n "agentSessionId|displayTarget|agent-lane|final|subagent" media/main.js src/OpenCodeClient.ts src/SidebarProvider.ts`

### Manual Validation

- [ ] S8.W3.U1 Complete Slice validation S8.V2: C emits diff/todo/progress/final/message content while B background; switching to B shows expected parent UI and agent-lane state.

### Rollback Boundary

- [ ] S8.W3.R1 Revert Wave 3 changes only; keep Wave 1/2 if verifier accepted them and regression is isolated to agent-lane content.

### Stop Conditions

- [ ] S8.W3.S1 Stop if existing product semantics for final summary promotion are ambiguous.
- [ ] S8.W3.S2 Stop if lane storage cannot preserve agent content without a broader data model change.

### Handoff And Gate

- [ ] S8.W3.H1 Coder handoff block must list changed files, commands run, observed output, open risks / next step.
- [ ] S8.W3.H2 Route the actual diff to `verifier` before Wave 4 begins.

## Wave 4 — Parent-Scoped Terminal And Clear Operations

### Scope

- **Files in scope:** `media/main.js`, `src/SidebarProvider.ts`, `src/OpenCodeClient.ts` only where terminal/clear commands/events are defined.
- **Files out of scope:** global shutdown/reset implementation except to name and preserve intentional global clear paths.

### Behavior Changed

- Terminal/clear operations for subagents are scoped by `parentSessionId`.
- Global clear remains possible only for named shutdown/reset paths with explicit logs and no accidental event-route reuse.

### Tasks

- [ ] S8.W4.T1 Audit terminal/clear senders and receivers identified in Wave 0; classify parent-scoped versus named global.
- [ ] S8.W4.T2 Add/require `parentSessionId` on parent-scoped terminal/clear operations.
- [ ] S8.W4.T3 Ensure webview clear only removes subagent terminal/state belonging to the target parent session.
- [ ] S8.W4.T4 Ensure global clear paths are named, explicit, and logged as global shutdown/reset.
- [ ] S8.W4.T5 Add route/drop logs for clear operations with missing or mismatched parent IDs.

### Acceptance Criteria

- [ ] S8.W4.A1 Parent B terminal/clear does not clear parent A/D subagents.
- [ ] S8.W4.A2 Missing parent on parent-scoped clear drops rather than clearing active or all sessions.
- [ ] S8.W4.A3 Named global shutdown/reset still clears globally when intentionally invoked.

### Machine Validation Commands

- [ ] S8.W4.M1 `node --check media/main.js`
- [ ] S8.W4.M2 `npm run compile`
- [ ] S8.W4.M3 `rg -n "terminal|clear|parentSessionId|global.*clear|SUBAGENT_ROUTE|SESSION_ROUTE_DROP" media/main.js src/OpenCodeClient.ts src/SidebarProvider.ts`

### Manual Validation

- [ ] S8.W4.U1 Slice validation S8.V3: Parent B terminal/clear does not clear parent A/D subagents.
- [ ] S8.W4.U2 Named global shutdown/reset clear still works if such a path exists in the product.

### Rollback Boundary

- [ ] S8.W4.R1 Revert only Wave 4 clear/terminal changes if scoped clear breaks intentional shutdown/reset behavior.

### Stop Conditions

- [ ] S8.W4.S1 Stop if a clear operation cannot distinguish parent-scoped from global by payload or call site.
- [ ] S8.W4.S2 Stop if preserving named global clear requires changing product lifecycle semantics.

### Handoff And Gate

- [ ] S8.W4.H1 Coder handoff block must list changed files, commands run, observed output, open risks / next step.
- [ ] S8.W4.H2 Route the actual diff to `verifier` before final Slice 8 acceptance.

## Wave 5 — Slice 8 Acceptance And Regression Pass

### Scope

- **Files in scope:** no new production edits unless acceptance reveals a defect and `researcher` approves a repair wave.
- **Files out of scope:** Slice 9 end-to-end cleanup/removing logs unless separately planned.

### Behavior Changed

- None unless a verifier-directed repair is approved.

### Tasks

- [ ] S8.W5.T1 Run compile and syntax checks after all accepted waves.
- [ ] S8.W5.T2 Run relevant tests; record unrelated pre-existing failures separately.
- [ ] S8.W5.T3 Execute manual validations S8.V1-S8.V3 with logs captured.
- [ ] S8.W5.T4 Inspect actual diff for no production edits outside approved Slice 8 scope.
- [ ] S8.W5.T5 Confirm no `tests/` temp directory contents are cleaned or committed.
- [ ] S8.W5.T6 Update parent plan Slice 8 status only after verifier accepts implementation and manual validations are recorded.

### Acceptance Criteria

- [ ] S8.W5.A1 S8.V1 passes: A active, B parent has subagent C update; B state changes, A DOM/send gate unchanged.
- [ ] S8.W5.A2 S8.V2 passes: C emits diff/todo/progress while B background; switching to B shows expected parent UI/agent-lane state.
- [ ] S8.W5.A3 S8.V3 passes: Parent B terminal/clear does not clear parent A/D subagents.
- [ ] S8.W5.A4 Verifier confirms parent/agent routing uses authoritative IDs, not mutable active/current session.

### Machine Validation Commands

- [ ] S8.W5.M1 `git status --short`
- [ ] S8.W5.M2 `node --check media/main.js`
- [ ] S8.W5.M3 `npm run compile`
- [ ] S8.W5.M4 `npm test -- --runInBand` if stable enough for regression signal.
- [ ] S8.W5.M5 `rg -n "SUBAGENT_ROUTE|SESSION_ROUTE_DROP|parentSessionId|agentSessionId|displayTarget|subagentToParentSessionMap|terminal|clear" src/OpenCodeClient.ts src/SidebarProvider.ts media/main.js`

### Manual Validation

- [ ] S8.W5.U1 Capture debug logs for S8.V1-S8.V3 and cite specific parent/agent IDs in the handoff.
- [ ] S8.W5.U2 Manually inspect A, B, and C UI surfaces: active A unchanged during B/C background updates; switching to B shows B parent state; C content remains in agent lane.

### Rollback Boundary

- [ ] S8.W5.R1 If acceptance fails, do not layer new broad changes. Open a focused repair wave against the failing accepted wave boundary.

### Stop Conditions

- [ ] S8.W5.S1 Stop if any route still falls back to active/current session for subagent ownership after async boundaries.
- [ ] S8.W5.S2 Stop if actual diff includes out-of-scope files without approved plan amendment.
- [ ] S8.W5.S3 Stop if verifier rejects a wave; return to `researcher` with verifier findings before continuing.

### Handoff And Gate

- [ ] S8.W5.H1 Final handoff block must include changed files, commands run, observed output, manual validation evidence, open risks / next step.
- [ ] S8.W5.H2 Route final Slice 8 diff/evidence to `verifier` before marking Slice 8 complete in the parent workflow plan.

## Cross-Wave Dependencies

- [ ] S8.D1 Wave 1 depends on Wave 0 identifying authoritative parent/agent sources and ambiguous payload gaps.
- [ ] S8.D2 Wave 2 depends on Wave 1 extension payloads being self-describing or on Wave 0 proving existing payloads are sufficient.
- [ ] S8.D3 Wave 3 depends on Wave 0 identifying current agent-lane content paths and existing promotion semantics.
- [ ] S8.D4 Wave 4 depends on Wave 0 terminal/clear classification.
- [ ] S8.D5 Wave 5 depends on verifier acceptance of Waves 1-4.

## Recommended Specialist Routing

- [ ] S8.SP1 Start with `explorer` or a read-only `coder` for Wave 0 audit. If exact routing surfaces are unknown, do not begin implementation.
- [ ] S8.SP2 Use `coder` for each implementation wave, one wave per dispatch.
- [ ] S8.SP3 Use `verifier` after each implementation wave before dispatching the next dependent wave.
- [ ] S8.SP4 Use `reviewer` only if Wave 0 reveals architectural ambiguity around agent-lane promotion or global clear semantics.

## First Recommended Action

- [ ] S8.NEXT1 Dispatch Wave 0 read-only audit with the exact grep commands above and require the audit table plus standard handoff block before any production code changes.
