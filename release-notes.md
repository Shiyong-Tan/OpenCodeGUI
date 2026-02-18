## Release Notes

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
