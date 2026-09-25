# Supervisor process cards

The GUI displays process evidence supplied by the task supervisor under the owning
task. Process names and colored status are visible; PID and execution identities
stay in collapsed Diagnostics. Running rows include observed duration, CPU,
working set and live process count. Root exit with descendants still running,
quiet activity, unknown observation and nonzero exits have separate labels.
All status text is English. Historical rows cannot display live CPU/memory or
running colors. Keyed updates preserve card/details identity and scroll.

The supervisor owns process state. GUI code only validates and projects optional
fields and never launches, cancels, scans for or adopts a process. Older snapshots
without the new fields remain valid. Command arguments, directories and output
are excluded at the protocol boundary. Parent/task/attempt/child identity checks
remain mandatory.

Tracked commands must be launched by a registered subagent through the companion
plugin's `supervisor_run` tool. New dispatch prompts contain this instruction;
ordinary shell commands do not become tracked automatically. Turning off the GUI
Supervisor switch hides observations and does not stop those commands. Plugin
code must be loaded by a subsequent normal service start; no running daily service
was restarted for this change.

GUI stays at 5.0.7. The additional keyed renderer and optional field validators
have a bounded 24 KiB minified / 8 KiB gzip Supervisor bundle budget. No dependency,
chat lifecycle, snapshot persistence or cross-session ownership changes.
