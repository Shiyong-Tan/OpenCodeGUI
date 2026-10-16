# OpenCode 1 and 2 compatibility

The client owns one session/turn pipeline. ProtocolConnectionOwner captures the
service origin, authentication, workspace and generation. Strict JSON identity
probes select the V1 transport or native V2Backend; version strings are diagnostic,
not allowlists. Changing the connection aborts captured work. An HTML SPA fallback
never proves API health. Unsupported operations fail explicitly, with no automatic
prompt resubmission or cross-protocol effectful fallback.

V2Backend composes session, control and interaction adapters. V2HistoryProjection
maps native facts into the existing UI history DTO; it does not emulate V1 HTTP.
V2EventIntegration serializes boundary work by owning session and deduplicates
event IDs. OpenCodeClient remains the only turn owner. Provider step completion
does not finalize a turn; native execution outcomes do. Empty terminal executions
resolve with an explicit error. Captured stale reads cannot finish newer turns.

Queued prompts retain durable inbox identities. Steer patches the existing inbox
item once rather than admitting another prompt. Uncertain admission stays pending
verification, never a blind retry. Rehydrated snapshots do not persist a live service
generation or grant an unverified Steer capability. Original session/request IDs and
the existing PermissionReviewService review tokens route permission and typed form
replies, including child interactions. Form values retain types, conditional fields
and option values. Manual compaction correlates native control admission and
started/ended events; V2 uses its configured compaction agent, without changing the
selected chat model or silently choosing a paid provider.

The Supervisor archive has a V1 root export and V2 `server` export plus a local
directory server.js entry. One package can therefore support both native loaders.
V2 configuration uses `plugins: [{package, options}]`; V1 uses `plugin` tuples.
Only Supervisor declarations are migrated; unrelated configuration and permission
rules are retained. V2 automatic installation requires the release's matching
protocol manifest. That metadata is a publisher advertisement checked against the
asset digest when GitHub supplies it; live authenticated bridge validation remains
required. No claim is made that arbitrary future semantic protocol changes work.

Validation uses isolated 1.18.31 and 2.0.24 services, private profiles and zero model
calls. Native plugin discovery/lease/snapshot is tested against real 2.0.24. Unit
tests cover models/roles, parallel tool identity, original interaction routing,
typed form replies, queued delivery conflicts, stale bindings and compaction
correlation. Real model-driven completion, interactive VS Code rendering, native
macOS and native Linux 2.0 executions require manual acceptance; fixtures are not
reported as real model tests. Published 0.1.5 predates this work: publish a new
dual-entry artifact and manifest before enabling automatic V2 installation.

Rendering retains the 77 KiB raw budget and raises gzip from 25 to 26 KiB for the
Steer control (measured 25,691 bytes). The feature bundle adds typed native form
controls, with bounded budgets of 58 KiB raw and 20 KiB gzip. Generated bundles are
built from typed sources and checked for deterministic output.

Final local gates (2026-10-16): GUI 234 suites / 1817 tests passed; extension
compile, all Webview budgets and deterministic build checks passed. Companion
plugin build/typecheck and 157 tests passed. Real isolated protocol probes passed
for 1.18.31 and 2.0.24; the latter also passed native session contract and
Supervisor lease/snapshot checks. All real service probes used zero model calls.
