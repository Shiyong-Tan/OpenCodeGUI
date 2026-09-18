# Supervisor Phase 4 — Extension read boundary (not wired yet)

This module is experimental and is not activated by the normal GUI path. It does
not create, cancel, retry or recover tasks. Plugin Registry/Executions/Notifications
remain the canonical owners. `SupervisorReader` validates and caches a projection;
credentials stay in `IsolatedSupervisorConnection` and must never enter Webview
messages or logs.

The descriptor must identify the exact isolated workspace and marker, loopback
service and separate authenticated bridge. No failed experimental connection may
fall back to the normal workspace lock or launch a production service. Composition
and a default-off development setting are still pending. Reloading the descriptor
must dispose the old reader and mark its displayed tasks historical/unknown.

`protocol.ts` and `notification-identity-protocol.ts` are synchronized from
OpenCodeTaskSupervisor source at commit 3d1a704 (only the import extension changes).
They are parsing/projection contracts, not alternate lifecycle state owners.

Do not classify notifications by text or synthetic flags. Trusted persistent
identities will be consumed by the existing history/event owners after the user
chooses follow-up reply ownership and timing. Existing snapshots and final messages
must remain unchanged. No such lifecycle change is part of this module commit.

Tests of this adapter use synthetic payloads unless explicitly marked as a real
isolated plugin probe. No GUI end-to-end acceptance is claimed by module tests.
