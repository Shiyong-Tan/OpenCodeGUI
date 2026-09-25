# Supervisor API compatibility

GUI 5.0.7 accepts valid OpenCode release/prerelease labels without an allowlist.
Version labels still travel unchanged through authenticated discovery, health,
live proof and snapshots; mismatched instances or versions remain rejected.
The Supervisor bridge schema and plugin protocol remain explicitly validated.

The companion OpenCodeTaskSupervisor probes required read endpoints and validates
actual operation responses. Extra fields and new release labels do not by themselves
disable supervision. Failed reads become unavailable observations, never completed
tasks. Effectful APIs are validated on use; no test task or model request is created
just to check compatibility. Unknown future SDK or semantic changes may still need
an adapter update; accepting a label is not a claim that every future release was
tested. Startup global-health reads are separated from workspace API probes to avoid
recursive plugin initialization.

Both components must contain this change. Install the refreshed 5.0.7 VSIX; the
rebuilt companion plugin takes effect at its next normal service load. There is no
automatic restart, migration, global configuration change or model request.

Tests cover new and prerelease labels, authenticated future-version connections,
service/version mismatch rejection, and retained UI unavailable-state handling.
Backend real-service checks cover 1.18.29 and 1.18.31 with no model calls. Future
version cases are simulated; they are not live-release certifications.

Validation: 95 focused Supervisor tests pass; full regression ran 201 suites with
1581 passes and one build-fingerprint comparison affected by concurrent rebuilding.
That exact comparison passed when rerun after builds finished. Compile, all bundle
budgets and deterministic build checks pass. Version remains 5.0.7.
