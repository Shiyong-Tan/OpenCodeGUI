# OpenCode 1.18.31 support in GUI 5.0.7

The supported Supervisor versions of OpenCode are exactly **1.18.29 and 1.18.31**.
Update both GUI and the separately installed OpenCodeTaskSupervisor build.
Installing the VSIX alone cannot fix `Unsupported OpenCode version` thrown by
an old Supervisor plugin. Plugin code loads at the next user-controlled service
start; this release does not automatically restart a service or edit configuration.

The official source audit compared OpenCode commits
`16747470f976aca3d362ad730bcd3fe82ecc2c9a` (1.18.29) and
`014614d35b397775e5d397a490fc72368c894ec2` (1.18.31). Used V1 HTTP contracts,
SDK generated code and plugin API/loading contracts are unchanged. Server error
middleware adds a remote-auth configuration error mapping to HTTP 400. Provider,
system-prompt and ACP changes do not establish compatibility for model behavior.
The companion repository records the detailed audit and sanitized real-service
evidence in `docs/OPENCODE-1.18.31.md`.

GUI now preserves the actual supported version throughout health verification,
signed discovery/live identity and snapshot parsing. A mismatch between these
boundaries remains a failure even when both versions are independently supported.
Unknown versions are not accepted through a semver range. No session lifecycle or
history ownership changed. Panel errors explain the two-component update and log
inspection steps without exposing raw service responses or credentials.

Validation: 201 Jest suites / 1570 tests passed; compile, Webview checks and
deterministic build passed. Supervisor passed 98 tests and both real isolated
1.18.29 and 1.18.31 no-model HTTP/plugin probes. The probes verified plugin loading,
authenticated bridge identity, lease/snapshot versions and empty child-session
create/read/status/permission/abort/delete. Test services exited. No paid model,
global configuration or daily service was used. Interactive installed-GUI and
model-loop acceptance on 1.18.31 were not rerun.
