# Production Webview compaction

The Phase 4 baseline already exceeded the unchanged rendering (75 KiB) and continuation
(51 KiB) limits. Production builds now run the pinned UglifyJS 3.19.3 after esbuild for
these two bundles. Development/watch/source-map builds retain the existing pipeline.
No feature, logging, public key, snapshot, or protocol field is removed.

`compact-webview.js` uses five compression passes, local-variable/function hoisting,
`unsafe: false`, and `pure_getters: false`. Rendering additionally shortens an explicit
allowlist of 26 implementation-private TanStack virtual-core fields. The library
version is pinned to 3.17.4; every field must still be declared private and absent
from production Webview consumers and media/main.js. The build fails if that boundary
changes. In particular, adapter-accessed getScrollOffset and scrollAdjustments are
excluded. No property mangling is applied to the continuation bundle.

UglifyJS was already installed as a transitive optional dependency; it is now a pinned
required development dependency with the existing lockfile integrity. Its BSD-2-Clause
license stays in the dependency package. TanStack remains one bundled implementation;
its public API and existing license treatment are unchanged. No runtime dependency or
network request is added.

Validation includes getter/error side effects, public facade descriptors, installed
real virtual-core range equivalence, private-boundary rejection, and the full Jest
suite. Actual isolated Webview history/PNG decode/scroll anchoring/process restart
and supervisor canonical-final/clock recovery also pass after compaction, with no
model calls. Evidence lives in OpenCodeTaskSupervisor/docs/evidence/phase4-gui-model/
H-compacted and R-compacted JSON/PNG files.

Final sizes: rendering 76,784 bytes (gzip 25,278); continuation 51,695 (gzip 13,987).
Original size limits are unchanged. Rendering has only 16 bytes of raw headroom;
future feature growth must address the size budget deliberately, not expand this
private-field list without reviewing its boundary or silently raise the gate.
The esbuild progress line reports intermediate size; check:webview measures the final
packaged bytes. Determinism now hashes continuation as well as rendering/supervisor.

2026-10-16: Independent subagent tool rows add 1,181 raw bytes over the recorded
76,784-byte baseline, yielding 77,965 bytes (gzip 25,512). The raw rendering limit
is deliberately increased from 75 to 77 KiB for this feature. The 25 KiB gzip cap,
dependency restrictions, pinned compactor, private-property allowlist and all other
bundle budgets remain unchanged. No compression safety option is weakened.

2026-10-16: The native Queued/Steer action raises rendering gzip to 25,691 bytes.
The gzip cap is deliberately increased from 25 to 26 KiB; raw remains 77 KiB.
Typed native form controls add about 3.6 KiB to the feature bundle. Feature limits
are now 58 KiB raw and 20 KiB gzip. Dependency and unsafe-code restrictions remain
unchanged; deterministic builds are required.
