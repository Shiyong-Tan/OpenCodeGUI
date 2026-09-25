# Supervisor switch installation

The explicit composer switch installs the pinned GitHub release into the current
workspace OpenCode plugin declaration. It never edits global OpenCode configuration
or permission rules. Existing JSONC comments and unrelated plugins are preserved;
existing files receive a backup. Ambiguous configurations, duplicate declarations,
redirected paths and concurrent setup fail with an actionable error.

`SupervisorSetup` owns config merging. `SupervisorSetting` owns the workspace flag
and restores it when activation fails. `OpenCodeClient` captures the workspace,
coalesces activation, and calls the existing service controller. The controller
retains OS ownership checks, activity confirmation, operation serialization and
stop evidence. External services are not stopped. An idle owned service restarts
automatically; running/waiting tasks require explicit interruption confirmation.

New declarations allow explicit Supervisor dispatch and disable automatic completion
notifications. Existing choices are retained. Installation itself does not call a
model. Outside a GUI-owned launch the plugin tools work without its private GUI
bridge. Turning the GUI switch off only disables observation; it does not uninstall
or stop tasks. After a restart/setup failure, the prepared plugin config remains
for inspection and the display flag returns to its previous value. Enabling again
retries setup; there is no background restart loop.

Distribution: https://github.com/Shiyong-Tan/opencode-task-supervisor
Pinned asset: `v0.1.0/opencode-task-supervisor-0.1.0.tgz`.
No npm publication is needed: OpenCode installs the HTTPS package on startup.
The release must exist before new installations can complete.

Validation: GUI full regression 205 suites / 1607 tests; clean public plugin tree
119 tests; isolated real OpenCode 1.18.31 HTTP tarball install exposed Supervisor
tools with zero model calls. This does not claim installed VS Code end-to-end
acceptance of the switch/restart prompt. Daily services were not restarted.
