# Slice 7 Append Workflow Isolation Wave Plan

> **High-risk workflow plan.** Append isolation touches session ownership, runtime retention, finalization, snapshots, hydration, git/change-list metadata, and UI rendering. Execute one wave at a time. After every implementation wave, run machine validation, perform the smoke path, inspect the actual diff, and return to `researcher` for code-reviewer wave-diff review before proceeding.

## Objective

Implement Slice 7 Append Workflow Isolation for OpenCodeGUI so append turns remain rooted in the correct originating session while child append messages remain UI/evidence identities only. Session switching must not clear or retarget append state, snapshots must persist append relationships, hydration must preserve append metadata, and final append change lists must use the union of authoritative root + latest append child message detail diffs.

## Existing Context To Preserve

- Current umbrella plan: `.opencode/plans/ACTIVE_CHAT_SESSION_SWITCH_WORKFLOW.md`, Slice 7 lines 331-359.
- Existing uncommitted work may be present and must not be cleaned up or overwritten:
  - `media/main.js`
  - `src/SidebarProvider.ts`
  - `src/__tests__/continuation/sidebar-undo-owner-routing.test.ts`
  - `src/__tests__/continuation/webview-reverted-segment-members.test.ts`
  - `tests/` temporary directory
- Slice 6 already documents and marks completed the authoritative change-list/git rule for append flows, but Slice 7 must verify the real append runtime still supplies the correct root/latest child identities through finalization.

## Core Invariants

- **S7.I1 Root-authoritative append ingress:** `appendMessage.sessionId`, `rootUserKey`, and `clientMessageId` are captured at append ingress and become the authoritative owner tuple for the append operation.
- **S7.I2 Child identity is evidence-only:** append child user IDs may be used for UI rendering, message detail lookup, and evidence, but must not change git/change-list owner session or root continuation owner.
- **S7.I3 No active/current ownership after ingress:** after append ingress capture, no await continuation, ack, assistant bind, finalize, change-list, commit bind, or snapshot path may re-read `currentSessionId`/`activeSessionId` as ownership proof.
- **S7.I4 Runtime state survives switching:** switching sessions must preserve `appendTurnStateBySession` and related per-session append state. `resetSessionState()` must not clear append state wholesale; `finishTurn()` must not delete append relation before final/change-list/commit-bind/snapshot completion; only true session deletion may clear it.
- **S7.I5 Retain relation through all side effects:** the background session must retain root-child append relation until final assistant bind, change-list computation, git commit/commit bind, and snapshot persistence are complete.
- **S7.I6 Snapshot persistence includes append relation:** snapshot payloads must persist root `meta.appendedPrompts`, append child relation, and root/child chain. Snapshot logic must not persist only the currently visible message array.
- **S7.I7 Hydrate/normalize preserves append metadata:** `normalizeDisplayMessagesForSnapshot()` and hydration/sessionData normalization must preserve and sanitize `meta.appendedPrompts` and related append metadata instead of wiping `meta` or append fields.
- **S7.I8 Final append file set is root + latest child union:** final append change-list/git file set uses authoritative `GET /session/:id/message/:messageID` detail responses for both the append root and latest append child. The final `info.summary.diffs` file set is their union, never child-only or root-only.
- **S7.I9 Active UI is render-only:** child append rendering may occur when the target session is active; background append mutations must update target session state without redrawing or scrolling another active session.

## Cross-Wave Dependencies And Risk Controls

- **Dependency D1:** Wave 0 audit must identify actual append state keys, lifecycle owners, cleanup sites, snapshot writers, and change-list identity inputs before any implementation wave.
- **Dependency D2:** Runtime retention must land before snapshot and change-list fixes; otherwise later waves cannot rely on append relation still existing when side effects run.
- **Dependency D3:** Snapshot/hydration metadata preservation should land before change-list union hardening if change-list code reads hydrated/snapshot-derived relation during background finalize or reload recovery.
- **Dependency D4:** Change-list/git union must not proceed unless the latest append child identity is proven durable across ack/final assistant/finalize.
- **Risk control:** Each implementation wave has a rollback boundary limited to one behavior class. Do not mix runtime retention, snapshot meta, and change-list union in one diff.
- **Risk control:** After each implementation wave, require actual-diff review in `code-reviewer` wave-diff mode before continuing.

## Recommended First Bounded Implementation Wave

**Recommended first implementation wave after audit: Wave 1 Runtime Retention And Ingress Ownership.**

Justification:
- It proves the foundational invariant: append ownership is root-authoritative and durable across session switching.
- Snapshot persistence and change-list union both depend on append relation surviving until final side effects complete.
- Starting with snapshot or change-list union before runtime retention risks treating symptoms while `finishTurn()`/`resetSessionState()` still erase the relation too early.
- A read-only audit is required first because the exact cleanup/normalization/change-list call sites must be confirmed from current code before safe edits.

---

## Wave 0 - Read-Only Append Ownership And Lifecycle Audit

**Specialist handoff:** `explorer` or `coder` in read-only/audit mode. No production edits.

### Files In Scope

- `media/main.js`
- `src/SidebarProvider.ts`
- `src/OpenCodeClient.ts` only if append events/session APIs are involved
- Existing tests under `src/__tests__/continuation/` only for pattern/reference review
- `.opencode/plans/ACTIVE_CHAT_SESSION_SWITCH_WORKFLOW.md` as context

### Files Out Of Scope

- No production code edits
- No cleanup of uncommitted files or `tests/`
- No broad undo/restore/conflict edits
- No unrelated UI refactors

### Behavior Changed

- None. This is read-only evidence gathering.

### Tasks

- [x] S7.W0.T1 Map append ingress: find `appendMessage` handlers/senders and record where `sessionId`, `rootUserKey`, and `clientMessageId` are captured or lost.
- [x] S7.W0.T2 Map append runtime state: identify `appendTurnStateBySession`, append composer draft state, appended prompt metadata, root-child relation fields, and their lifecycle owners.
- [x] S7.W0.T3 Map cleanup sites: identify `finishTurn()`, `resetSessionState()`, true session deletion, hydration reset, and any other append-state deletion/overwrite paths.
- [x] S7.W0.T4 Map snapshot writers/readers: identify snapshot payload construction, `normalizeDisplayMessagesForSnapshot()`, sessionData hydration, and any meta sanitization that may strip `meta.appendedPrompts`.
- [x] S7.W0.T5 Map finalization chain: identify append ack, child user insertion, final assistant binding, `chatDone`, change-list update, git commit/commit bind, and snapshot persistence ordering.
- [x] S7.W0.T6 Map authoritative diff union inputs: locate current root/latest-child message detail lookup code and confirm whether append runtime provides both message IDs at finalization.
- [x] S7.W0.T7 Produce a short audit note in this plan or a sibling `.opencode/plans/` note listing exact functions/cases and the proposed Wave 1 edit targets.

### Acceptance Criteria

- [x] S7.W0.A1 Audit names every append ownership source and every place that can retarget append ownership to `currentSessionId`/`activeSessionId`.
- [x] S7.W0.A2 Audit names every append state cleanup path and classifies it as allowed session deletion, too-early finalization cleanup, or unsafe wholesale reset.
- [x] S7.W0.A3 Audit names snapshot/hydration meta paths that must preserve append metadata.
- [x] S7.W0.A4 Audit confirms whether change-list union currently has both root and latest append child IDs at the time it computes final files.

### Machine Validation Commands

- [x] S7.W0.M1 Run static searches only, for example: `rg -n "appendMessage|appendTurnStateBySession|appendedPrompts|rootUserKey|clientMessageId|normalizeDisplayMessagesForSnapshot|finishTurn|resetSessionState|summary\.diffs|messageDetail|getMessage" media src`
- [x] S7.W0.M2 No compile/test command is required because no code changes occur.

### Manual Validation

- [x] S7.W0.U1 Manually inspect audit findings against S7.I1-S7.I8 and mark any invariant without a concrete implementation target as blocked.

### Smoke Path

- [x] S7.W0.S1 Confirm no files except the audit/plan note were modified.
- [x] S7.W0.S2 Confirm the existing app behavior is intentionally unchanged.

### Rollback Boundary

- [x] S7.W0.R1 Delete only the audit note if it is incorrect. No production rollback should be needed.

### Stop Conditions

- [ ] S7.W0.X1 Stop if append ingress cannot prove a stable `sessionId`, `rootUserKey`, or `clientMessageId`; return to `researcher` with the missing proof.
- [ ] S7.W0.X2 Stop if append relation fields are ambiguous or derived only from currently visible DOM/messages.
- [ ] S7.W0.X3 Stop if current code has multiple live duplicate append handlers and the audit cannot prove which are reachable.

---

## Wave 1 - Runtime Retention And Root-Authoritative Ingress

**Specialist handoff:** `coder` for bounded implementation after Wave 0 audit; `code-reviewer` for actual-diff review before Wave 2.

### Files In Scope

- `media/main.js` for webview append command ingress, per-session append UI/runtime state, render gating, hydration-triggered reset behavior
- `src/SidebarProvider.ts` for extension append operation owner capture/finalization state if Wave 0 identifies extension-side cleanup/retargeting
- `src/OpenCodeClient.ts` only for narrowly required explicit append/session APIs found by Wave 0
- Focused tests only if existing harness patterns already cover similar continuation/session ownership behavior

### Files Out Of Scope

- Snapshot payload schema changes beyond preserving existing append state from being deleted
- Change-list/git union algorithm changes
- Undo/restore/conflict files
- Broad session routing refactors unrelated to append
- Cleanup of unrelated uncommitted files

### Behavior Changed

- `appendMessage` captures `{ sessionId, rootUserKey, clientMessageId }` once at ingress and routes the entire append operation by that tuple.
- Switching active sessions preserves `appendTurnStateBySession` and related per-session append state.
- `finishTurn()` defers append relation cleanup until final/change-list/commit-bind/snapshot completion has explicitly occurred.
- `resetSessionState()` no longer clears append state wholesale; only true session deletion clears append runtime state for that session.

### Tasks

- [x] S7.W1.T1 Add or tighten append owner capture at ingress: require/capture `appendMessage.sessionId`, `rootUserKey`, and `clientMessageId` before async work starts.
- [x] S7.W1.T2 Replace append continuation gates that read changed `currentSessionId`/`activeSessionId` with captured target-session/root gates.
- [x] S7.W1.T3 Ensure child append user ID is stored as UI/evidence identity only and cannot overwrite root owner/git/change-list owner.
- [x] S7.W1.T4 Update session-switch and hydration reset paths so they preserve `appendTurnStateBySession` and per-session append composer/draft state.
- [x] S7.W1.T5 Update `finishTurn()` cleanup so append relation survives until final assistant bind, change-list update, commit bind, and snapshot persistence report completion or are explicitly deferred.
- [x] S7.W1.T6 Restrict append state deletion to true session deletion or explicit completed-retention cleanup that proves all side effects are done.
- [x] S7.W1.T7 Add stable route/retention logs, e.g. `[WV][APPEND_ROUTE]`, `[WV][APPEND_RETAIN]`, `[EXT][APPEND_ROUTE]`, `[EXT][APPEND_RETAIN]`, without noisy per-token output.
- [x] S7.W1.T8 Add focused tests or harness checks for session switch retention if existing test infrastructure can do so without broad harness work.

### Acceptance Criteria

- [ ] S7.W1.A1 Append operation started in A remains owned by A after switching to B before ack/finalize.
- [ ] S7.W1.A2 `appendTurnStateBySession` remains intact after session switch, sessionData hydration, `finishTurn()`, and `resetSessionState()` unless true session deletion occurs.
- [ ] S7.W1.A3 Append child identity appears in UI/evidence fields but root owner fields remain unchanged.
- [ ] S7.W1.A4 No success-path append finalization code uses active/current session as ownership proof after ingress.

### Machine Validation Commands

- [x] S7.W1.M1 `node --check media/main.js`
- [x] S7.W1.M2 Run project type/compile check if available from `package.json`.
- [x] S7.W1.M3 Run focused continuation/session tests if available, e.g. existing `src/__tests__/continuation/*` patterns or newly added append-retention tests.
- [ ] S7.W1.M4 Static grep: `rg -n "appendMessage|appendTurnStateBySession|rootUserKey|clientMessageId|finishTurn|resetSessionState|currentSessionId|activeSessionId" media/main.js src/SidebarProvider.ts src/OpenCodeClient.ts`

### Manual Validation

- [ ] S7.W1.U1 In UI/logs: open session A, submit append, immediately switch to B before ack/finalize; B remains visually unchanged while A receives append user/final state.
- [ ] S7.W1.U2 Switch back to A before finalization completes; append draft/runtime/final binding state is still present.
- [ ] S7.W1.U3 Delete a session intentionally; only that session's append runtime state is cleared.

### Smoke Path

- [ ] S7.W1.S1 Script load: app/webview loads with no syntax errors (`node --check media/main.js` passes).
- [ ] S7.W1.S2 Primary action: normal non-append send still starts and finalizes in active session.
- [ ] S7.W1.S3 State transition: append in A, switch to B, switch back to A; A retains append relation and B is not redrawn by A background events.
- [ ] S7.W1.S4 No regression: send button/busy state remains active-session scoped from earlier slices.

### Rollback Boundary

- [ ] S7.W1.R1 Revert only append ingress/retention changes and associated focused tests/logs. Do not revert prior Slice 1-6 accepted fixes or unrelated uncommitted files.

### Stop Conditions

- [ ] S7.W1.X1 Stop if append owner cannot be captured before the first async boundary.
- [ ] S7.W1.X2 Stop if cleanup ordering cannot prove final/change-list/commit-bind/snapshot completion; do not guess cleanup timing.
- [ ] S7.W1.X3 Stop if runtime retention requires broad finalization or snapshot rewrite; split a new wave and return to `researcher`.

---

## Wave 2 - Snapshot And Hydration Append Metadata Preservation

**Specialist handoff:** `coder`; `code-reviewer` actual-diff review before Wave 3.

### Files In Scope

- `media/main.js` for snapshot payload construction, `normalizeDisplayMessagesForSnapshot()`, hydration/sessionData normalization, per-session state restore
- `src/SidebarProvider.ts` only if extension snapshot persistence payload needs append metadata fields forwarded or validated
- Focused snapshot/hydration tests if existing harness supports webview/session snapshot behavior

### Files Out Of Scope

- Runtime ingress/retention changes except bug fixes required by Wave 1 review
- Change-list/git union algorithm changes
- Undo/restore/conflict files
- Broad snapshot schema migration unrelated to append metadata

### Behavior Changed

- Snapshot persistence includes root `meta.appendedPrompts`, append child relation, root/child chain, and relevant append owner/evidence fields.
- `normalizeDisplayMessagesForSnapshot()` preserves existing safe metadata instead of replacing/wiping `meta`.
- Hydration/sessionData normalization restores append relation and appended prompt metadata even when the append session is background.

### Tasks

- [x] S7.W2.T1 Identify canonical append metadata schema to preserve: root `meta.appendedPrompts`, child relation fields, root key, child message ID, client message ID, and any chain/parent IDs used by UI.
- [x] S7.W2.T2 Update snapshot payload construction to persist append metadata from session-owned state, not active DOM-only state.
- [x] S7.W2.T3 Update `normalizeDisplayMessagesForSnapshot()` to sanitize append metadata while preserving `meta.appendedPrompts` and root/child relation fields.
- [x] S7.W2.T4 Update hydration/sessionData normalization so append metadata survives loading and does not overwrite newer live append state with stale snapshot data.
- [x] S7.W2.T5 Add logs around append snapshot/hydrate preservation, e.g. `[WV][APPEND_SNAPSHOT_META]` and `[WV][APPEND_HYDRATE_META]`.
- [x] S7.W2.T6 Add focused tests for normalize/hydrate preservation where feasible.

### Acceptance Criteria

- [ ] S7.W2.A1 Snapshot payload for append root includes `meta.appendedPrompts` and root/child relation after background finalization.
- [ ] S7.W2.A2 Hydrating a session with append metadata preserves root/child chain and does not collapse root/child into two unrelated bubbles.
- [ ] S7.W2.A3 Metadata sanitizer removes unsafe/transient values but does not wipe append metadata.
- [ ] S7.W2.A4 Background append snapshot does not use B's active visible message array for A.

### Machine Validation Commands

- [x] S7.W2.M1 `node --check media/main.js`
- [x] S7.W2.M2 Run focused snapshot/hydration tests if available or newly added.
- [ ] S7.W2.M3 Static grep: `rg -n "normalizeDisplayMessagesForSnapshot|appendedPrompts|snapshot|sessionData|hydrate|meta" media/main.js src/SidebarProvider.ts`

### Manual Validation

- [ ] S7.W2.U1 Append in A, switch B, allow A to finalize and snapshot in background; reload/select A and confirm append renders as a single rooted continuation chain, not two unrelated bubbles.
- [ ] S7.W2.U2 Inspect logs/snapshot payload evidence that root `meta.appendedPrompts` and child relation persisted.

### Smoke Path

- [ ] S7.W2.S1 Script load passes with no syntax errors.
- [ ] S7.W2.S2 Primary append action still inserts child/evidence UI correctly.
- [ ] S7.W2.S3 State transition: hydrate A while B active; B remains visible and A metadata is preserved in state.
- [ ] S7.W2.S4 No regression: normal non-append snapshot/hydrate still restores timeline order.

### Rollback Boundary

- [ ] S7.W2.R1 Revert only append snapshot/hydration metadata preservation and focused tests/logs. Preserve Wave 1 runtime retention if accepted.

### Stop Conditions

- [ ] S7.W2.X1 Stop if snapshot schema cannot represent root/child append relation without migration; return with schema options.
- [ ] S7.W2.X2 Stop if normalization currently strips all `meta` for security reasons and safe allowlisting is unclear.
- [ ] S7.W2.X3 Stop if stale hydrated snapshot can overwrite newer live append relation; split live-vs-historical merge rules before proceeding.

---

## Wave 3 - Authoritative Root + Latest Append Child Diff Union

**Specialist handoff:** `coder`; `code-reviewer` actual-diff review before Wave 4/end-to-end acceptance.

### Files In Scope

- `src/SidebarProvider.ts` for final change-list/git/commit-bind ownership and message detail union if current code is extension-owned
- `src/OpenCodeClient.ts` only for explicit message detail APIs if needed
- `media/main.js` only for missing append identity payloads required by extension finalization
- Focused tests covering append union and ownership after switching

### Files Out Of Scope

- Snapshot/hydration changes except bug fixes required by Wave 2 review
- Undo/restore/conflict changes
- Broad git/change-list refactor unrelated to append union
- Session-wide diff aggregation as primary final file source

### Behavior Changed

- Final append change-list/git file set fetches authoritative message details for both append root and latest append child via `GET /session/:id/message/:messageID`.
- Final file set is the union of `rootDetail.info.summary.diffs` and `latestChildDetail.info.summary.diffs`.
- Root owner remains the git/change-list owner; child identity contributes files/evidence only.
- Session-wide diff aggregation remains fallback/debug evidence only, not primary final ownership/file source.

### Tasks

- [x] S7.W3.T1 Verify append finalization has durable root message ID/key and latest append child message ID at change-list computation time.
- [x] S7.W3.T2 Update final append change-list/git path to fetch root message detail and latest append child message detail from the originating session.
- [x] S7.W3.T3 Union `info.summary.diffs` file sets deterministically, preserving file status/conflict metadata rules already established in Slice 6.
- [x] S7.W3.T4 Ensure commit-bind/change-list owner fields remain root-authoritative while child details are recorded as evidence/source.
- [x] S7.W3.T5 Add logs proving root detail, child detail, union count, and owner session/root.
- [x] S7.W3.T6 Add focused tests for root-only, child-only, and overlapping root+child diffs.

### Acceptance Criteria

- [x] S7.W3.A1 Append final change list includes files changed by root and files changed by latest append child.
- [x] S7.W3.A2 Append final change list is not child-only when root has diffs and is not root-only when latest child has additional diffs.
- [x] S7.W3.A3 Git commit/change-list owner remains append root owner/session after switching to B.
- [x] S7.W3.A4 If either message detail fetch fails, behavior is conservative and logged; no guessed active-session fallback.

### Machine Validation Commands

- [x] S7.W3.M1 Run TypeScript/extension compile check if available from `package.json`.
- [x] S7.W3.M2 Run focused change-list/git append tests if available or newly added.
- [ ] S7.W3.M3 Static grep: `rg -n "summary\.diffs|getMessage|messageDetail|append|rootUserKey|clientMessageId|changeList|commit" src media/main.js`

### Manual Validation

- [ ] S7.W3.U1 In UI/logs: append in A changes root-associated and child-associated files, switch to B before finalization, then confirm A final change list contains the root+latest-child union.
- [ ] S7.W3.U2 Confirm B receives no change-list/git metadata from A's append.

### Smoke Path

- [ ] S7.W3.S1 Extension/webview compile checks pass.
- [ ] S7.W3.S2 Primary append action finalizes and produces change list.
- [ ] S7.W3.S3 State transition: append A, switch B before finalization; A side effects bind to A root owner.
- [ ] S7.W3.S4 No regression: non-append change-list/git path still uses authoritative message detail diffs per Slice 6.

### Rollback Boundary

- [ ] S7.W3.R1 Revert only append union logic and focused tests/logs. Preserve Wave 1 retention and Wave 2 metadata preservation if accepted.

### Stop Conditions

- [ ] S7.W3.X1 Stop if latest append child ID is unavailable or unstable at finalization; return to Wave 1/Wave 2 identity preservation.
- [ ] S7.W3.X2 Stop if message detail API cannot fetch both root and child for the same originating session.
- [ ] S7.W3.X3 Stop if union semantics conflict with existing Slice 6 file status rules; request design decision before coding further.

---

## Wave 4 - End-To-End Append Isolation Acceptance

**Specialist handoff:** `coder` for validation execution; `code-reviewer` for final Slice 7 review.

### Files In Scope

- Tests and validation notes only unless Wave 1-3 reviews identify a small targeted fix
- `.opencode/plans/ACTIVE_CHAT_SESSION_SWITCH_WORKFLOW.md` may be updated by `researcher` after acceptance to mark Slice 7 completion

### Files Out Of Scope

- New feature work
- Slice 8 subagent routing
- Undo/restore/conflict changes
- Cleanup of unrelated uncommitted files

### Behavior Changed

- No new behavior beyond confirming Waves 1-3 work together.

### Tasks

- [ ] S7.W4.T1 Run all machine validations from Waves 1-3.
- [ ] S7.W4.T2 Execute manual append-switch-finalize-reload scenario and collect logs.
- [ ] S7.W4.T3 Confirm root/child render as intended after reload and do not split into two unrelated bubbles.
- [ ] S7.W4.T4 Confirm final change-list/git metadata includes root+latest-child union and remains A-owned while B active.
- [ ] S7.W4.T5 Request code-reviewer final Slice 7 review with actual diff and validation evidence.
- [ ] S7.W4.T6 Only after review acceptance, update umbrella plan Slice 7 status and validation checkboxes.

### Acceptance Criteria

- [ ] S7.W4.A1 S7.V1 passes: submit append in A, switch B before ack/finalize; A receives append user/final/change-list state, B unchanged.
- [ ] S7.W4.A2 S7.V2 passes: append draft/open runtime state in A survives switching to B and hydrating sessions.
- [ ] S7.W4.A3 S7.V3 passes: append-generated git/change-list metadata remains owned by A root owner, not B/latest visible user.
- [ ] S7.W4.A4 Snapshot/reload acceptance passes: append relation persists and hydrates with metadata intact.
- [ ] S7.W4.A5 Change-list union acceptance passes: final files are authoritative root+latest-child `summary.diffs` union.

### Machine Validation Commands

- [ ] S7.W4.M1 `node --check media/main.js`
- [ ] S7.W4.M2 Run project compile/type check from `package.json`.
- [ ] S7.W4.M3 Run focused continuation/session/append tests.
- [ ] S7.W4.M4 Run any broader smoke test suite that is practical without disturbing uncommitted files.

### Manual Validation

- [ ] S7.W4.U1 Manual full path: A append start -> switch B -> A ack/finalize in background -> B remains unchanged -> switch A -> append root/child chain visible -> reload A -> chain still intact -> change-list union correct.
- [ ] S7.W4.U2 Manual deletion path: deleting A clears A append state only; switching/hydrating never clears it wholesale.

### Smoke Path

- [ ] S7.W4.S1 Script load works.
- [ ] S7.W4.S2 Normal send works.
- [ ] S7.W4.S3 Append send works.
- [ ] S7.W4.S4 Session switch during append does not redraw wrong active session.
- [ ] S7.W4.S5 Reload/hydrate preserves append relation.

### Rollback Boundary

- [ ] S7.W4.R1 If final acceptance fails, rollback only the last reviewed wave that introduced the failure. Do not rollback unrelated accepted prior slices or pre-existing uncommitted files.

### Stop Conditions

- [ ] S7.W4.X1 Stop if any manual scenario shows A append state rendering into B or B change list receiving A metadata.
- [ ] S7.W4.X2 Stop if reload loses `meta.appendedPrompts` or root/child relation.
- [ ] S7.W4.X3 Stop if final append change-list file set is root-only or child-only when evidence shows both have diffs.

## Final Dispatch Guidance

- [ ] S7.D1 Dispatch Wave 0 first as a read-only audit; do not let implementation begin until exact edit targets are known.
- [ ] S7.D2 Dispatch Wave 1 as the first bounded implementation wave after audit because runtime retention/ingress ownership is the prerequisite for snapshot and change-list correctness.
- [ ] S7.D3 Require code-reviewer actual-diff review after each implementation wave.
- [ ] S7.D4 Preserve all unrelated uncommitted files and avoid cleanup operations.
- [ ] S7.D5 Do not mark Slice 7 complete until runtime retention, snapshot/hydrate metadata preservation, and root+latest-child diff union all pass validation.
