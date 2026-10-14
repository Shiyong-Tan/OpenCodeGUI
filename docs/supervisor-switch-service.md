# Supervisor switch and Linux service ownership

Enabling the workspace Supervisor switch saves the configuration and starts or
restarts only the GUI-owned idle service. Linux/WSL uses the existing service
controller/record store, POSIX canonical workspace identity, /proc birth ticks,
a random GUI service marker and listener FD ownership. Windows keeps its Job
backend. Linux uses util-linux flock for cross-window operation serialization;
EOF releases its kernel lock even on an extension-host crash. macOS remains on
start/reuse behavior, without new process-control claims.

Running main/child turns, manual compaction, pending permission/question requests
and currently observed tracked executions block switch mutation. UI activity is
a projection; the backend checks local ownership plus service API evidence before
configuration changes and the controller rechecks activity before stopping.
Unknown activity is refused. A restart never overrides active work via approval.
New GUI sends are blocked during Supervisor setup. Disabling hides supervision
without cancelling/restarting the backend or its processes.

Service records remain signed and private, keyed by canonical workspace. Linux
stops only the registered root, never name-matched processes or calculation trees.
If descendants remain in its process group, stop evidence is incomplete and restart
is refused. Escaped descendants are not containment-guaranteed; activity checks
and explicit ownership limits remain essential. External/legacy services without
an owned record are not taken over: finish work, stop through their original owner,
then use GUI Start Service once. Subsequent switches can restart that owned service.

Tests use fake request boundaries and a separate WSL temporary HTTP fixture for
birth identity, inherited Supervisor binding, kernel locking, cross-reload ownership,
listener ownership, rejected foreign/PID-reused identities, and verified stop.
No everyday services, global config, models or production databases are touched.
