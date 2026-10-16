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

Initial protocol validation uses isolated 1.18.31 and 2.0.24 services, private profiles and zero model
calls. Native plugin discovery/lease/snapshot is tested against real 2.0.24. Unit
tests cover models/roles, parallel tool identity, original interaction routing,
typed form replies, queued delivery conflicts, stale bindings and compaction
correlation. Subsequent Windows real-model acceptance and Linux/WSL service/process
checks are recorded in OPENCODE-2-WINDOWS-ACCEPTANCE.md. Full interactive VS Code
window acceptance and native macOS are not certified; mocked-host browser checks
are not reported as complete Extension Host tests. Native automatic installation
requires the dual-loader 0.1.8 distribution and matching protocol manifest; the older
published 0.1.5 archive predates this work.

Rendering retains the 77 KiB raw budget and raises gzip from 25 to 26 KiB for the
Steer control (measured 25,691 bytes). The feature bundle adds typed native form
controls, with bounded budgets of 58 KiB raw and 20 KiB gzip. Generated bundles are
built from typed sources and checked for deterministic output.

Final local gates (2026-10-16): GUI 234 suites / 1817 tests passed; extension
compile, all Webview budgets and deterministic build checks passed. Companion
plugin build/typecheck and 157 tests passed. Real isolated protocol probes passed
for 1.18.31 and 2.0.24; the latter also passed native session contract and
Supervisor lease/snapshot checks. All real service probes used zero model calls.

OpenCode 2 installation correction (2026-10-16): native package installation does not accept raw release archive URLs. GUI setup selects the official compiled Git distribution tag for V2 and validates its release protocol manifest before changing configuration. V1 retains release archive URLs. The shared server export implements legacy server() and native setup() loader contracts. Both sources belong to one release; later plugin releases do not require a GUI version bump. Supervisor 0.1.6 and 0.1.7 remain prereleases; use 0.1.8 or later.

Cold Supervisor activation: assertSupervisorSwitchIdle may return early when no service is listening, so it is not evidence of a protocol binding. enableSupervisor now ensures the service and its canonical protocol owner first, rechecks remote activity, and requires a current binding before configuration changes. Protocol discovery failure never selects a legacy default or writes configuration. No production service is restarted during regression tests.

Large native transcript regression: a real read tool embedded about 25 MiB in a single assistant record. The original 8 MiB page bound prevented authoritative terminal reconciliation. V2Backend retries only oversized GET pages at the same cursor with a halved page size, preserving the total transcript message bound and identity validation. V2Transport allows 32 MiB only for a single-record transcript GET; ordinary resources retain 8 MiB. No records are dropped. Completed child tool rows are a hidden presentation projection; persisted tool facts stay intact.

Supervisor handshake regression: plugin 0.1.9 published a live lease under OpenCode 2.0.31 but connectNormalSupervisor still required /global/health. Reuse the canonical read-only protocol probe (strict V1 JSON or native /api/info) before the unchanged bridge challenge. HTML fallback never establishes health; authenticated lease version must still match the selected service. This fixes a GUI boundary, not plugin installation.

Child text projection: SidebarChatEventHandler receives text chunks, not complete text. Child progress reads the existing OpenCodeClient assistant-text cache by canonical message identity; no second accumulator or cross-message concatenation is introduced. Native Supervisor location aliases share one registry/bridge owner in companion 0.1.10 to prevent an empty parallel instance from replacing discovery.
