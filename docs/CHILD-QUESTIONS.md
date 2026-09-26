# Child question review

Pending OpenCode questions owned by the selected session or its descendants use
one existing question card above the composer. Requests are answered one at a
time; child identity is displayed. Single choice, multiple choice, custom text and
multi-question requests retain the existing renderer. No pending request means no
card. Dismiss explicitly rejects the original request.

OpenCode remains the request owner. PermissionReviewService is the shared bounded
scope/liveness verifier, parameterized by request kind; question answers are
validated by QuestionProtocol. Each decision captures workspace, original session,
request ID and a token bound to the inspected request. A new inspection precedes
submission. Controller and renderer never choose a target from visible-session
state. Completed/aborted tools cannot be answered through residual requests.

createQuestionReview owns the visible remote draft queue. SSE triggers refresh;
3-second reconciliation recovers missed events and reconnects. Scope/refresh IDs
reject stale snapshots. Identical requests preserve drafts and avoid rerendering.
The session overlay store receives only a processing-pause projection keyed by the
original child session. Existing synthetic local questions keep their owner.
Question events after final cannot reactivate a terminal assistant turn.

Supervisor separately observes /question and reports waiting_question (displayed
as Waiting for answer). Waiting for user input is not evidence of a stalled task.
No automatic answer, approval, cancellation or redispatch is introduced.

Validation includes shared backend ownership/answer tests, queue isolation and
draft tests, terminal-event and overlay projection tests. The isolated real-service
probe scripts/question-live-probe.cjs uses OpenCode 1.18.31 with a fixed local
HTTP fixture, no paid model: two concurrent child questions, exact answer/reject
routing, and abort with a residual request all passed. This verifies protocol
integration, not autonomous model behavior. A browser fixture checked the existing
card renderer, multi-step answers, draft retention and advancing to the next child.
