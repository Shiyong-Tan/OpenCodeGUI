# Supervisor Phase 4 — Extension read boundary (development transport wired)

This module is experimental. The normal GUI path leaves it disabled. It does
not create, cancel, retry or recover tasks. Plugin Registry/Executions/Notifications
remain the canonical owners. `SupervisorReader` validates and caches a projection;
credentials stay in `IsolatedSupervisorConnection` and must never enter Webview
messages or logs.

The descriptor must identify the exact isolated workspace and marker, loopback
service and separate authenticated bridge. No failed experimental connection may
fall back to the normal workspace lock or launch a production service. The default-off
development setting and read-only overlay are wired. An instance change requires
window reload; the reader rejects its response and the overlay marks cached evidence
historical/unknown. The launcher retains service shutdown ownership.

`protocol.ts` and `notification-identity-protocol.ts` are synchronized from
OpenCodeTaskSupervisor source at commit 3d1a704 (only the import extension changes).
They are parsing/projection contracts, not alternate lifecycle state owners.

Notifications are classified by trusted persistent IDs in the existing history/event
paths, never text or synthetic flags. The user has selected independent follow-up
rounds and first-observed-activity timing. That lifecycle integration remains pending;
existing snapshots and final messages must remain unchanged.

Tests of this adapter use synthetic payloads unless explicitly marked as a real
isolated plugin probe. No GUI end-to-end acceptance is claimed by module tests.

## Durable notification catalog

SupervisorNotificationCatalog reads exact message IDs from the launcher's identity
directory after the experiment validates the connection. It does not classify by
text, synthetic flags, or parent-ID resemblance. Missing individual records mean
unclassified; an unavailable directory, corrupt/foreign/oversized record or redirect
fails explicitly. Immutable positive entries are bounded at 1,024; misses are never
cached. Historical instance IDs remain usable within the same validated isolation.
Seven real temporary-file tests cover reload, late registration, foreign session,
same-text user IDs, corrupt evidence, size/path limits and missing directory.

Realtime SSE now passes through a per-session ordered trust gate before the existing
event mapper. The gate has a 2.5-second identity deadline, 128 session lanes and
512 queued events per lane; a failed lane stays blocked until connection reload.
Other sessions continue independently. Internal message IDs are removed before
append/final/text-control handling; their real assistant descendants are not marked
hidden. Full/recent exports populate the same identity catalog before formatting;
formatting skips only exact trusted internal user records, retaining source input.
The existing snapshot owner and final lifecycle are not changed by classification.

The independent follow-up lifecycle remains unimplemented. Classification alone
does not let a terminal parent start a new UI round: the existing terminal guard
still rejects later activity. Do not use this intermediate state for model GUI
acceptance or claim that real follow-up display/reload has passed.
