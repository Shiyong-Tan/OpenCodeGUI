## Release Notes

### 5.0.7 (updated 2026-09-26)

- Review child permissions and questions from the parent session using the existing cards, one request at a time. Question answers support single/multiple choice and custom text, preserve drafts during polling, and return to the original child request.
- Recover pending requests after reconnect and prevent responses to expired or cancelled tool requests. The companion Supervisor update displays question waits as `Waiting for answer`.
- Improve Supervisor floating controls, status colors and task titles, and add plugin installation/activation from the workspace switch with active-task restart confirmation.
- Keep the GUI version at 5.0.7. Install the updated local VSIX; these follow-up changes have not been published to the existing GitHub release. The companion plugin's new question status takes effect on the next normal service start.
- See [Changelog](CHANGELOG.md) and [child question behavior](docs/CHILD-QUESTIONS.md) for details. Local agent permission customizations are separate from the GUI package.

### 5.0.6

- Added default-off task supervision, trusted notification follow-up rounds, and persistent history recovery for Windows / OpenCode 1.18.29 with the separately installed OpenCodeTaskSupervisor plugin.
- Added explicit Start / Stop / Restart Service commands with verified ownership and active-task confirmation. Closing or reloading the GUI does not stop the service.
- Fixed inline math beside Chinese text and optimized production bundles within existing limits.
- Install `opencode-gui-5.0.6.vsix` from this GUI repository. See [setup and safety boundaries](docs/PHASE5-TRIAL.md); supervision is opt-in and service restart does not resume in-memory tasks.

### Earlier changes

- Refined Change List delta rendering for visual symmetry:
  - Rebuilt `+x | -y` as a fixed 3-column CSS grid (`plus | minus`) so spacing is controlled by layout, not whitespace.
  - Separator now renders as a pure `|` character with centered alignment and tunable width via `--change-sep-width`.
  - Added dedicated delta columns (`--delta-col-width`) for stable alignment across different number widths and zoom levels.

- Improved assistant file-link behavior:
  - Linkify applies only to finalized assistant content (`isThinking !== true`), not in-progress streaming text.
  - Supports both `path/to/file.ext:line(:col)` and file-only `path/to/file.ext` (opens at line 1).
  - Works in normal text and inline code, while still skipping code blocks (`<pre>`) and existing links (`<a>`).
- Tightened file-path matching to reduce false positives (e.g. `cam.project`, `1.5`, `e.g.`) while preserving valid project paths.
- Fixed session title source mapping so chat headers use the correct session title instead of falling back to generic `Session`.
- Updated session header title layout: max width 60% with ellipsis for long titles.
