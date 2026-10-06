# Supervisor during an OpenCode service outage

The October 6 log contains 5,610 unreachable health checks, 5,611 failed resyncs,
and repeated restart-limit/cooldown messages. Event delivery ceased while the
verifier task was active. Its last persisted dispatch return was a normal
checkpoint; no subsequent Supervisor alert return was recorded for that task.

This is a service/transport outage, not proof that an individual child process is
dead. The main agent and Supervisor plugin execute through the same OpenCode
service. If that service is unreachable, an in-service plugin cannot reliably
deliver an alert, make the parent reason, cancel the child, or establish that all
managed/external processes stopped. Automatic overlapping redispatch is unsafe.

`OpenCodeClient` retains canonical turn state and owns outage notice deduplication
by session and captured turn-state identity. Confirmed failed health checks emit
`serviceUnavailable` once per waiting owner. The host projects an explicit warning
into that owner's session. Event-failure handling does not automatically restart a
service with waiting turns. Recovery emits a notice only for the same surviving
turn, and requires fresh task/process evidence rather than claiming completion.
An outage never synthesizes a model answer, task result, or process-stop proof.

`SupervisorCards` records local receipt time for each accepted snapshot. Repeated
failed polls retain that snapshot while its displayed ages increase. Polling
success and connection recovery are not themselves task progress. These local
display times do not mutate the plugin's evidence or the persisted snapshot.

Operator recovery remains explicit: inspect service logs and attributable process
state, then choose whether to restart the service. Verify old execution stopped
and account for partial outputs before dispatching any replacement. A separate
external watchdog could monitor service liveness, but cannot safely infer task
success or stop ownership without additional evidence and an explicit policy.

Validation uses local protocol/clock fixtures and production event routing.
No live service restart, model invocation, automatic cancellation or redispatch
is performed by these tests.
