# Git Undo/Restore Workflow (Internal Bare Repo)

This document defines the internal Git-based undo/restore workflow used by OpenCode. It replaces the snapshot engine and uses a dedicated bare Git repository with a work-tree pointing to the workspace root. No user .git is touched.

## Goals
- Use an internal bare Git repo as the only state engine for undo/restore.
- Never read or write the user's .git.
- Never create .git in the workspace root.
- Undo/restore only touches files modified by tools.
- If Git is unavailable or too old, disable undo/restore entirely.

## Non-Goals
- No snapshot fallback.
- No global git operations or full-workspace checkout.
- No hard reset.

## Capability Detection
Run once on activate or before the first write:
- `git --version`
- Parse version; require >= 2.30.
- On failure: set `undoDisabled=true`, do not create repos, hide/disable undo UI, instruct user to install/upgrade Git and restart VS Code.

## Repository Layout
Workspace root:

```
.opencode/git/
  repos/
    repo_<uuid>.git/   (bare repo)
      index            (dedicated index file)
  index.json           (schemaVersion + turnKey/sessionId -> repoId)
  sessions/
    <sessionId>/
      map.json         (schemaVersion + commit mapping & metadata)
```

All Git commands MUST be executed with:
- `--git-dir <repoPath>`
- `--work-tree <workspaceRoot>`
- `GIT_INDEX_FILE=<repoPath>/index`

## Repo Resolution
`resolveRepo(workspaceRoot, sessionId?, turnKey?)`:
1) If `sessionId` exists and `index.json.sessionToRepo[sessionId]` exists → use it.
2) Else if `turnKey` exists and `index.json.turnToRepo[turnKey]` exists → use it.
3) Else create `repo_<uuid>.git`, write `turnToRepo[turnKey]=repoId`.
When sessionId first appears, bind `sessionToRepo[sessionId]=repoId` and create `sessions/<sessionId>/map.json`.

## Concurrency and Locks
All git operations and map.json writes MUST be serialized per repo:
- Per-repo async queue (promise chain)
- File lock `<repoPath>/.lock`

The lock/queue must wrap:
- Git commands
- map.json reads/writes
- revertedSegment persistence

## Path Normalization and Safety
All paths:
- Normalize to workspace-relative POSIX (`/`).
- Reject absolute paths, UNC paths, `..`, and paths outside workspace.
- Use `-- <paths>` in all git commands.

## Map Format (sessions/<sessionId>/map.json)
Required fields:
- `schemaVersion: 1`
- `sessionId`
- `repoId`
- `headCommit`
- `entries[]`: append-only
- `tmpToCommit`: tmpKey -> commitHash
- `msgToCommit`: msgId -> commitHash

Entry fields:
- `turnKey`
- `tmpKey`
- `assistantMsgId`
- `finalAssistantMsgId`
- `messageIndex`
- `commitHash`
- `touchedFiles[]`
- `opType: update|create|delete|rename|multi`
- `timestamp`

## Commit Workflow
Every tool write that lands on disk creates a commit:
1) Normalize `touchedFiles` from tool events (apply_patch/edit/write/delete).
2) Apply staging by opType:
   - delete: `git rm --ignore-unmatch -- <path>`
   - create/update: `git add -- <path>`
   - rename: `git add -A -- <old> <new>` (path-restricted)
3) If `git diff --cached --name-only` is empty → no-op (no commit).
4) Commit with explicit identity:
   `git -c user.name=OpenCode -c user.email=opencode@local commit -m "opencode: <turnKey> <timestamp>"`
5) `git rev-parse HEAD` → commit hash.
6) Update map.json atomically (headCommit + entries + tmpToCommit/msgToCommit).

Notes:
- Use pathlist chunking on Windows to avoid command-length limits.
- If `touchedFiles` is empty, skip all pathspec commands.

## Final Assistant ID Binding
When export-resolved selects the final assistant msgId:
- Lookup `tmpToCommit[tmpKey]`.
- If missing: no-op + log.
- Else: `msgToCommit[finalMsgId] = commitHash` and update entry.finalAssistantMsgId.
- This update must be atomic and within the repo lock/queue.

## FileSet Computation
For undo/restore operations:
1) `changedPaths = git diff --name-only <targetCommit>..<headCommit>`
2) `fileSet = union(changedPaths, touchedFilesUnion)`

`touchedFilesUnion` scope:
- Only entries between `startCommit..headCommit` within the same session/repo.

## Precheck: Ensure Workspace Matches Commit
`ensureWorkspaceMatchesCommit(commit, fileSet)`:
- For each path, check if it exists in commit:
  `git cat-file -e <commit>:<path>`
- If commit has path:
  - `git diff --name-only <commit> -- <path>` must be empty.
- If commit does NOT have path:
  - If workspace has the file, treat as conflict (avoid deleting user-created files).

Use chunked pathlist calls for performance.

## Undo Workflow
`undoFromMessage(sessionId, startMsgId)`:
1) Resolve repo + lock.
2) `startCommit = msgToCommit[startMsgId]`.
3) `headCommit = map.headCommit`.
4) `targetCommit = parent(startCommit)`; if no parent, use EMPTY_TREE semantics.
5) `fileSet = computeFileSet(target..head + union touchedFiles)`.
6) Precheck: ensure workspace matches `headCommit` for `fileSet`.
7) Apply: `applyCheckoutToCommit(targetCommit, fileSet)`.
8) Record revertedSegment with:
   - `restoreCommit = headCommit`
   - `undoTargetCommit = targetCommit`
   - `fileSet`

### applyCheckoutToCommit
For each path in `fileSet`:
- If `<commit>:<path>` exists → `git checkout <commit> -- <path>`
- Else → `unlink` the file from workspace (do not delete directories).

## Restore Workflow
`restoreAll(sessionId)`:
1) Resolve repo + lock.
2) Load revertedSegment (restoreCommit + undoTargetCommit + fileSet).
3) Precheck: ensure workspace matches `undoTargetCommit` on `fileSet`.
4) Apply: `applyCheckoutToCommit(restoreCommit, fileSet)`.
5) Clear revertedSegment.

## Edge Cases
- startCommit is root: targetCommit = EMPTY_TREE (valid undo).
- tmpKey missing at finalizeBinding: no-op + log.
- map.json writes are atomic (write tmp + replace).
- Empty pathlist → no-op for checkout/add/rm/diff.

## Logging (OpenCode UI Debug)
Required log points:
- detectGit: version / ok / fail reason
- resolveRepo: turnKey/sessionId -> repoId
- repoLock: acquire/release + queue length
- commit: opType, files, stagedCount, commitHash
- finalizeBinding: tmpKey -> finalMsgId -> commitHash
- fileSet: changedPaths.size / touchedUnion.size / fileSet.size
- precheck: commit / fileSet.size / conflicts
- undo: startMsgId / startCommit / targetCommit / restoreCommit / fileSet.size
- restore: restoreCommit / fileSet.size / conflicts
