# Undo/Restore Design (Authoritative Flow)

Last updated: 2026-03-07

This document defines the canonical Undo/Restore behavior for OpenCodeGUI.

## 1. Source of Truth

- Extension side (`OpenCodeClient` + `SidebarProvider`) is the business source of truth.
- Webview is render/cache only.
- Segment membership is authoritative by `messageIds[]`.
- `anchorMsgId/endMsgId` are boundary identifiers and lookup helpers, not member truth.

## 2. Core Segment State

A segment stores:

- `noticeKey`
- `startMessageId` (`anchorMsgId` in webview payload)
- `endMessageId`
- `messageIds[]` (authoritative ordered member list)
- `collapsed`
- `restoreAllowed`
- `discarded`
- `startCommit/startCommits`
- `undoTargetCommit`
- `restoreCommit`
- `fileSet`
- `operationId`

Rules:

- Do not persist start/end indexes.
- Recompute indexes from message IDs at runtime.
- `restoreAllowed` is monotonic: once `false`, never back to `true`.

## 3. `currentBaseCommit` Movement

`currentBaseCommit` lives in session map (`GitSessionMapStore`) and is the precheck baseline.

- Undo success: `currentBaseCommit = undoTargetCommit` (move backward).
- Restore success: `currentBaseCommit = restoreCommit` (move forward).

## 4. Undo: Commit Read Order

In `GitUndoEngine.undoFromMessage`:

1. Input: `startMsgId` + candidate `messageIds`.
2. Resolve `startCommit` from `msgToCommit[startMsgId]`.
3. If missing, fallback by scanning candidate `messageIds` (latest-first) for first mapped commit.
4. Resolve `messageBaseCommit`:
   - `msgToBaseCommit[startMsgId]` (authoritative).
5. Resolve `undoTargetCommit`:
   - `messageBaseCommit` if present.
   - else fallback to `parent(startCommit)`.
   - else `EMPTY_TREE` (root fallback).
6. Resolve `restoreCommit` as undo pre-state:
   - `map.currentBaseCommit` if present, else `map.headCommit`.
7. Resolve precheck baseline:
   - `precheckBase = map.currentBaseCommit || map.headCommit`.

## 5. Undo: File List Generation (`fileSet`)

1. Build ordered commits from undo range `messageIds` (map `msgToCommit`, dedupe, sort by entry order).
2. Collect `touchedFiles` union from those commits (authoritative source).
3. Compute `diff(undoTargetCommit..firstOrderedCommit)` as supplementary coverage.
4. `fileSet = unique(diffPaths + touchedUnion)`.
5. If empty, return `applied=true` with `reason=no-file-set`.
6. Build per-file action plan against `undoTargetCommit`:
   - target missing + workspace exists => delete
   - target exists + workspace missing => recreate
   - both exist and content differs => overwrite
   - same content => skip
7. Run precheck on `precheckBase`.
8. If no conflicts, apply plan.

## 6. Undo Sequence (Extension)

1. Receive `undoToMessage(anchorMsgId)` from webview.
2. Validate anchor exists in `messageIndexById`.
3. Compute undo range `[startIndex..effectiveEndIndex]`.
4. If empty range, noop explicitly (no tail-recover expansion).
5. Build authoritative `messageIds` from range.
6. Call `gitUndo.undoFromMessage(sessionId, startMessageId, messageIds, force)`.
7. On success, build/merge segment:
   - merge only if previous segment is active and safely mergeable
   - merge members by `messageIds` union (ordered + deduped)
   - `endMessageId = last(messageIds)` and re-derived index
8. Emit `revertedSegment` to webview.
9. Persist via `undoSegmentUpsert`.

## 7. Restore: Commit Read Order

In `GitUndoEngine.restoreToMessage`:

1. Input: `noticeKey` (primary), with `endMsgId/messageIds` as fallback sources.
2. Load authoritative segment from extension persisted map.
3. Resolve `restoreCommit` from segment.
4. If missing, rebuild from segment `messageIds` commit mapping.
5. Resolve precheck baseline:
   - `precheckBase = map.currentBaseCommit || map.headCommit`.

## 8. Restore: File List Generation (`fileSet`)

1. Prefer persisted `segment.fileSet`.
2. If missing/empty, rebuild from `segment.messageIds` commit diffs.
3. Normalize + dedupe to workspace-relative set.
4. Build per-file restore plan toward `restoreCommit`.
5. Run precheck on `precheckBase`.
6. If no conflicts, apply plan.

## 9. Restore Sequence (Extension)

1. Receive `restoreSegment` from webview.
2. Resolve segment by `noticeKey` (fallback to in-memory current if needed).
3. Validate:
   - `restoreAllowed !== false`
   - `restoreCommit` valid
   - `messageIds` non-empty
4. Call `gitUndo.restoreToMessage(sessionId, endMsgId, messageIds, force)`.
5. On success:
   - emit `restoredSegment`
   - remove segment from memory/persistence
   - clear changelist reverted flags tied to this segment commit set

### 9.1 Restore With Merged Invalid Segments

When a newer undo segment folds over older invalid segments:

- The parent active segment may carry `mergedInvalidSegments[]` snapshots.
- These snapshots are UI/persistence metadata only; they do not participate in git restore target selection.
- On restore success of the parent segment:
  - restore the parent active messages/files
  - rehydrate each `mergedInvalidSegments[]` child back into `segmentsByNoticeKey`
  - recreate its placeholder/card in the webview
  - keep each child `restoreAllowed=false`
  - do not reinsert those child messages into the normal message flow

Rules:

- A merged invalid segment must reappear after restore in the same invalid/greyed segment state it had before being folded.
- A merged invalid segment is not considered "restored" by restoring the parent segment.
- Parent segment removal must not delete child invalid segment snapshots before they are replayed.

## 10. Conflict Checks (Undo/Restore)

Both flows run precheck before apply:

- Compare workspace content vs expected content on `precheckBase`.
- On conflict return structured entries:
  - `path`
  - `expectedExists`
  - `currentExists`
  - `diffText`
- UI may retry with `force=true`.
- Failed retry must not mutate segment state.

## 11. Segment Merge Rules

Merge previous segment only when:

- previous segment is active and not discarded
- previous range is strictly after current anchor in valid order
- previous `messageIds` are present and valid

After merge:

- trust `messageIds` only
- merge `startCommits` with dedupe
- recompute `endMessageId` from merged `messageIds`
- preserve segment commits:
  - `segmentStartCommit` (same as `restoreCommit`)
  - `segmentEndCommit` (same as `undoTargetCommit`)

## 12. Restore Lock Rule (`restoreAllowed`)

Monotonic rule:

- Once `restoreAllowed=false`, never becomes `true`.
- Any file change from main agent or subagent triggers `segmentRestoreLock`.
- Lock applies to all active segments in current session.
- Extension and webview merges must preserve sticky false.

## 13. UI Invariants

- Segment collapse/expand uses `messageIds` only.
- Placeholder rendering must not rewrite unrelated timeline messages.
- Invalid boundaries should be logged and preserved, not silently rewritten.
- Reload/hydrate must preserve segment state, collapsed state, and restore availability.

## 14. Change List Interaction

Undo/Restore logic is independent from changelist anchoring, but changelist generation is:

1. At finalize, resolve `headCommit`.
2. Resolve `baseCommit = parent(headCommit)`.
3. Build file list from `git diff --name-only base..head`.
4. Build stats from `git diff --numstat base..head`.
5. Bind to display user ID policy.
6. No-op files are expected to be absent from final changelist.

### 14.1 Change List Rules For Invalid Segments During Restore

Restore must distinguish between:

- active messages actually being restored
- merged invalid segment messages merely being replayed as invalid cards

Therefore:

- `restoreFromMessage(...)` may receive the full parent segment message set for file restoration planning, with invalid child messages excluded from restore execution.
- changelist red-flag clearing must use only the active restored message subset.
- commits belonging to merged invalid segments must keep their reverted/red state after parent restore.

Authoritative rule:

- If an invalid segment still exists after restore, its changelist reverted marker must remain red.

## 15. Regression Guards

- `OpenCodeClient.undoFromMessage`:
  - merged segment end index derives from merged `endMessageId`
  - merge uses `messageIds` set, not stale index windows
- `media/main.js`:
  - `restoreAllowed` upsert keeps existing `false` sticky
- `SidebarProvider.ts`:
  - persisted segment merge keeps `restoreAllowed=false`
  - restore changelist clearing excludes `mergedInvalidSegments[]`

## 16. Required Logging

Add/assert hard logs:

- `SEGMENT_INVARIANT_FAIL` (empty messageIds, broken boundaries)
- `COMMIT_CHAIN_FAIL` (missing undoTarget/restoreCommit when required)
- `RESTORE_LOCK_MONOTONIC_FAIL` (`false -> true` attempt)

Every undo/restore operation should log:

- `noticeKey`
- `messageIds.count`
- `undoTargetCommit`
- `restoreCommit`
- `touchedFiles.count`
- `conflicts.count`

## 17. Acceptance Criteria

1. Undo folds full range, not just single user message.
2. Restore restores full segment and removes segment entry.
3. Any file change immediately disables restore and never rebounds.
4. Reload preserves segment/collapse/restore state.
5. No regressions in unrelated pipelines:
   - user injection stripping
   - assistant final selection
   - changelist display anchor/position

## 18. Message Base Commit Binding

To avoid undo/restore drift across adjacent segments:

1. On commit creation, capture turn base as `tmpToBaseCommit[tmpKey] = currentBaseCommit || headCommit`.
2. On finalize binding:
   - `msgToCommit[userMsgId/finalMsgId] = commitHash`
   - `msgToBaseCommit[userMsgId/finalMsgId] = tmpToBaseCommit[tmpKey]`
3. Undo always resolves target from `msgToBaseCommit[startMsgId]` when available.
