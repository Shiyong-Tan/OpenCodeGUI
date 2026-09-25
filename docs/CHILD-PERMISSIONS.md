# Child-session permission review

## Observed incident and root cause

The affected service is OpenCode 1.18.31 in the OpenLPT workspace. That workspace
was inspected read-only and is not a repair target. No PR was contacted or changed.

Parent: `ses_1338bacc1ffekoP4O4akH06mGJ`.
Child: `ses_f29b21b86ffeS3FLTtFHmi4pV0`, reviewer, title
`Review three focused PRs (@reviewer subagent)`.
Supervisor task: `c45ce3ee-5f80-4712-b930-c0d23f6a3e53`, attempt
`1c615179-7d63-499f-a27b-d6522e229f98`.

Authenticated read-only queries confirmed four actual `external_directory`
requests for the temporary `opencode` folder, tied to four `read` calls:

| Request | Call | Requested file |
| --- | --- | --- |
| per_0d64ee128001GpA7099NfX1h5h | call_667r33tr | pr13_body.json |
| per_0d64ee1d9001EuixSuck0LupeR | call_c60cmys7 | pr15_body.json |
| per_0d64ee31d0014VypZ7dyLrfBty | call_1m2qbuct | pr16_body.json |
| per_0d64ee3b4001gxNgcIVl5j125W | call_fb804b51 | pr13.diff |

The missing UI has reproducible code causes:

1. `SidebarChatEventHandler` returned from its generic child-session branch
   before reaching permission forwarding. This affects ordinary child sessions
   too; Supervisor children use the same server `parentID` relation.
2. The old Webview renderer required the request session to equal the visible
   session, and its store held only one permission per session.
3. There was no authoritative pending-request refresh on session selection,
   Webview reload or reconnection. The legacy fallback could choose the first
   permission for a session when an exact request ID was missing.
4. The event mapper could discard permission replies after chat finality.

Historical SSE receipt was not retained for this incident; we do not claim that
a particular past event reached the renderer. The static paths are covered by
regression tests, and genuine child asks were exercised on an isolated service.

## Ownership and response contract

OpenCode owns the pending permission list. `PermissionReviewService` verifies
the selected session's ancestry, workspace, original request ID and originating
tool/message. It issues an opaque review token bound to that exact request,
service connection and displayed scope. The Webview is a keyed read projection,
not a new permission authority. Existing session overlay state receives only a
verified blocker projection for its own session's timing.

The parent sees all requests belonging to its children, with agent/title, tool,
permission and patterns. Collapsed details contain original session/request IDs
and tool arguments. Distinct requests never replace one another. The only offered
actions are **Approve once** and **Reject**; there is no automatic or persistent
allowance. OpenCode rejection can reject other pending permissions in the same
child session; it does not authorize anything in sibling sessions.

Every click is revalidated against fresh server state before one POST to
`/permission/{originalRequestId}/reply`. The request is never substituted with a
parent request or the first item in a list. Changed input/service, foreign scope,
missing IDs/tokens, inactive tools and duplicate submissions fail closed.
Transport failures have visible feedback and no automatic reply retry. A new
explicit click requires fresh validation.

Refresh runs on selection, permission events and reconnection, plus every three
seconds while a session is visible. Scope and refresh identities fence late
responses. On read failure existing actions are disabled. These queries do not
restart or recover a service. Missing tool evidence is unknown, not permission
to approve. Completed/errored tools or aborted assistants make residual requests
inactive; they appear under a collapsed **Inactive requests** section with no
enabled actions. Idle alone does not expire a request.

## Old task disposition and limits

At the final read-only inspection all 17 tool records were settled: 6 read, 3
skill, 6 bash and 2 glob, with no pending/running records. The last assistant is
`MessageAbortedError`; the four blocked reads are `error / Tool execution aborted`.
The backend still lists all four permissions. The new inspector classified all
four `expired` and issued no review tokens. No reply/abort/restart was sent to this
old task, and no review was resumed.

The earlier six ordinary shell calls have completed tool records but no registered
OS process-tree evidence. This is not proof that every descendant stopped. The
Supervisor cancellation outcome therefore remains uncertain and must not become
`safeToRetry: true`. Backend orphan records are not silently rejected or removed;
the GUI prevents acting on them, and the companion plugin excludes proven expired
requests from `waiting_permission` while retaining cancellation uncertainty.

## Validation and touched boundaries

- GUI full regression: 204 suites / 1600 tests passed. Final focused recheck:
  6 suites / 67 tests passed. Compilation, Webview checks and deterministic
  production build passed. Supervisor regression: 133 tests passed.
- Headless Edge exercised the rendered panel with concurrent requests, an
  inactive request, duplicate clicks and failed replies. This is a browser
  fixture check, not an installed VS Code end-to-end acceptance run.
- `src/permissions/PermissionReviewService.ts`: scope, liveness, tokens and replies.
- `OpenCodeClient`, `UtilityCommandController`, `SidebarProvider`: bounded transport
  and explicit scope/request message routing.
- Both event adapters: deliver child permissions without changing chat finality.
- `webview-src/permissions/permission-review.ts`, continuation facade and thin
  `media/main.js` wiring: keyed multi-request display, recovery and actions.
- Unit and regression tests cover foreign owners, simultaneous requests, late
  snapshots/replies, cancellation residuals, failed replies and no implicit allow.
- `scripts/permission-live-probe.cjs`: real isolated OpenCode 1.18.31, a harmless
  fixture file, and a deterministic loopback HTTP model simulator. Parent review,
  approval, rejection and cancellation pass; the temporary service exits. Four
  local fixture HTTP requests, **zero paid-model calls**. This is not a real-model
  behavioral acceptance claim.

GUI remains 5.0.7. No global configuration edits, ordinary service restarts,
OpenLPT edits or push. The updated companion plugin takes effect at its next
normal service start; GUI review works directly with the current OpenCode API.

## Pending-only panel visibility

The composer panel is shown only while pending asks exist in its scope.
Inactive requests alone, an empty list, or a polling failure without pending
asks do not occupy composer space. The last acknowledged decision hides the
panel; background refresh still discovers new asks. Visibility regression:
5 focused tests passed.

## Sequential permission cards

Permission review reuses the existing question-overlay, conflict-card and
permission-card-actions styles. Only the first pending request is shown;
acknowledgement advances the queue and fresh server validation enables the next
response. Polling preserves insertion order and the current card. Expired and
unknown requests are omitted from this action queue. Hidden or detached cards
cannot submit a decision. The overlay does not consume composer layout space.

## Supervisor display cleanup

Floating controls are vertically stacked at the right edge. The live list and
icon health include only current work: terminal, ended and cancel_unknown rows
are hidden, as is previous-service history. Waiting for permission, suspected
stalls and unreachable active tasks remain visible. At the user's request,
cancellation-uncertain rows are hidden without changing their backend evidence.
This is display cleanup, not record deletion or proof that execution stopped.
