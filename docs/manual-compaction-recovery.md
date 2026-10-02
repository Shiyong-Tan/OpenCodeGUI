# Failed manual compaction recovery

An observed manual compaction failed with an upstream endpoint-unavailable error.
Its user control still contained a single `compaction` part with `auto: false`.
The next ordinary prompt was accepted, but its only assistant response was a
completed compaction summary, followed by idle. The summary-only guard correctly
reported no answer; it did not prevent the failed control from being reused.

OpenCode's prompt loop consumes pending compaction tasks with the latest user as
the parent. Its completed-assistant exit test can then end that user's turn after
the summary. See the upstream [prompt loop](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/prompt.ts).

`OpenCodeClient` owns the per-session manual-compaction operation. It serializes
manual compactions and rejects competing ordinary sends until the operation ends.
`ManualCompaction` verifies a failed manual control at the history tail, an idle
backend, and unchanged message/part identities before removing only that control
part through OpenCode's part API. The parent record, provider error, user text,
attachments, successful summaries, automatic compactions and snapshots are retained.
Cleanup is verified by reading back the history. Busy, changed, malformed or
unconfirmed state stops the operation instead of submitting another model request.

The same preflight runs before ordinary sends and appends, covering failed controls
left by older GUI versions. Requests retain their captured workspace and session
turn identity. This is not an automatic retry: no question is replayed and no model
is called by cleanup. A previously consumed question still needs an explicit send.

Error finalization carries the failed temporary assistant key. The Webview removes
it only if it still belongs to that command, has no canonical final identity, and
contains no real content or evidence. Another session, a newer temporary key,
partial replies and unknown content-bearing metadata are preserved.

Regression coverage uses local protocol fixtures and the production handler wiring.
Live model execution and interactive VS Code acceptance are separate from these
tests; neither is performed by the repair tests.
