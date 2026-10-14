# Linux/WSL service startup diagnostics

LinuxServiceOwner records stdout and stderr for each GUI-owned service launch in
`<service-operation-directory>/<serviceId>.startup.log`. The service ID is the same
canonical ownership identity used for registration. The GUI debug output reports
the path once after launch; a pending Supervisor discovery prompt also includes it.

The private file uses mode 0600 and retains at most 64 KiB during the first ten
minutes. Known password, token, key, proxy and Supervisor binding environment
values are redacted, including credentials split across output chunks. Do not log
arbitrary sensitive content merely because this transport is available.

A detached output drainer owns the FIFO reader. The service inherits its writer
directly, so reloading the extension host does not close the service's output
pipe. The drainer continues consuming output after the recording limit and on
file write failure. It does not own service lifecycle or kill service descendants.

This applies to future GUI launches only. Previously discarded output cannot be
recovered. Missing discovery output alone does not establish an installation,
network or plugin failure; inspect this log and OpenCode's own logs first.

`scripts/test-linux-service.mjs` uses an isolated HTTP fixture and verifies private
logging, redaction and output after the launching GUI closes its writer handle,
alongside service ownership and stop checks. It does not invoke a model.
