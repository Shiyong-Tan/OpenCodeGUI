# Windows native OpenCode 2 acceptance — 2026-10-16

Scope: Windows is the requested acceptance target. GUI remains 6.0.0. Real model
requests use only openai/gpt-6-luna. The user raised the cumulative ceiling from
10 to 50 requests; all 50 attempts are accounted for, including network failures
and two conservatively reconciled requests from a failed test-guard load. No
additional model requests are authorized. Initial restricted-network attempts
failed; the successful isolated runs used permitted network access. Each run used
an empty workspace, private XDG/config/database paths and a separately spawned
service. Existing OpenAI OAuth was used only in temporary credentials; no global
configuration or ordinary service was changed.

| Boundary | Observed result |
| --- | --- |
| Real native prompt | Authorized model returned the exact requested marker and succeeded |
| Real Supervisor dispatch | One registered reviewer child, tracked harmless Node process, process wait, CHILD_OK and parent PARENT_OK; no duplicate dispatch |
| Queued/Steer | Production client admitted one queue identity and patched that same identity to steer; original turn returned STEER_OK |
| Concurrent sessions | Production client returned both session answers after visible-session switch; a test expecting the waiter map key to disappear was corrected because UI finishTurn owns that cleanup |
| Parallel native tools | Two calls completed in one assistant message with distinct call IDs; shared child tool routing/rendering identity is regression-tested separately |
| Child question approval | Parent-scoped production client discovered two genuine child forms; a new client recovered them, a foreign parent saw none, duplicate decisions were rejected, approved child returned QUESTION_OK |
| Child question rejection | With explicit user feedback, the same child returned QUESTION_REJECTED and an idle outcome |
| Child read permission | Original request IDs were approved/rejected through production PermissionReviewService; no pending request remained after rejection |
| Compaction | Production client correlated native started/ended events and returned success; durable compaction survived reconnect |
| Interruption | An explicit native interrupted event without an idle record released only the owning client's wait after fresh active/inbox/interaction checks |

Some interaction fixtures explicitly selected the first tool to make the requested
permission/question case deterministic. Supervisor parent/child dispatch used the
model's normal tool selection. Test permissions authorized only known fixture
operations; production approval rules were not relaxed. Model tests used the real
OpenCode service and production client/interaction adapters, not a mocked provider.

Production Webview HTML and bundles were also loaded in local Edge with a mocked
VS Code messaging host. The browser assertions verified child question display,
original child/request submission, original option values and advancement to the
next question without JavaScript errors. This is not a full VS Code Extension Host
test or a complete visual/manual long-session checklist. Isolated VS Code window
automation was unavailable; that limitation is retained rather than called passed.

Real Linux/WSL 2.0.24 additionally passed session/event/catalog/form probes, native
plugin lease and snapshot, process CPU/output/exit/descendant ownership and GUI
service start/reload-ownership/stop checks, with no model requests. Native macOS is
not tested and was excluded from the current acceptance scope by the user.

Fixes found by this work: the empty-answer fallback overwrote an accepted success;
native form rejection without feedback stopped the step; custom-answer forms hid
their fixed options; deliberate interruption could lack an idle record. Focused
regressions cover these transitions, pending work, stale events and shutdown.

Final gates: 234 GUI suites / 1827 tests passed, plugin 157 tests passed;
extension compilation, all Webview budgets and deterministic bundles passed.
Companion 0.1.6 actual package manifests (without test export rewriting) load
successfully in isolated Windows 1.18.31 and 2.0.24 services and publish matching
authenticated leases/snapshots, with zero additional model requests.

OpenCode 2 installation correction (2026-10-16): native package installation does not accept raw release archive URLs. GUI setup selects the official compiled Git distribution tag for V2 and validates its release protocol manifest before changing configuration. V1 retains release archive URLs. The shared server export implements legacy server() and native setup() loader contracts. Both sources belong to one release; later plugin releases do not require a GUI version bump. Supervisor 0.1.6 and 0.1.7 remain prereleases; use 0.1.8 or later.

Installation follow-up gates: 234 GUI suites / 1828 tests and 158 plugin tests passed; compilation, Webview budgets and deterministic bundles passed. One initial test run overlapped bundle rebuilding and detected changing bundle hashes; the complete run after builds stopped passed. This was a validation scheduling error, not a suppressed assertion.

2026-10-16 production-sized history regression: the real affected session contains 3610 projected messages and one approximately 25 MiB embedded read output. The old response bound blocked final reconciliation; adaptive paging plus a bounded single-record read successfully projected the complete transcript with active=false, outcome=succeeded and the latest full assistant text. Verification used authenticated read-only requests, zero model calls, no prompt or production restart. Gates: 236 suites / 1837 tests. Supervisor 0.1.9 adds authenticated bootstrap reuse across native location recreation with foreign-workspace rejection; real isolated V1/V2 remote install/lease/snapshot passed.

2026-10-16 Supervisor GUI handshake follow-up: actual production NormalSupervisorIntegration completed authenticated discovery, native identity probing, signed bridge challenge and two successive observed snapshots against isolated Windows 1.18.31, 2.0.24 and the locally installed 2.0.31 CLI, all with plugin 0.1.9. The original package-only probe did not exercise this GUI boundary and missed its legacy-only health check. No model calls or ordinary service/configuration changes. Native HTML-fallback and malformed-identity regression cases retain fail-closed behavior.

2026-10-16 child stream/location-alias follow-up: child card text now reads the existing canonical accumulated assistant cache by message ID, rather than treating a text delta as a full replacement. Regression covers successive deltas and a new assistant message. Plugin 0.1.10 shares a reference-counted runtime for one signed service/workspace; registration in one location is readable in an alias after first-location disposal. Actual isolated installed Windows 2.0.31 production GUI handshake/snapshot passed and a second drive-letter-case location kept the identical observation bridge instance. Zero model requests and no ordinary service restart.
