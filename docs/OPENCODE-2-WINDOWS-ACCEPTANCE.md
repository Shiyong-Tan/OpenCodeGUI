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
