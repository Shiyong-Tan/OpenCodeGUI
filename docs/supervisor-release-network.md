# Supervisor release request transport

The October 14 report shows successful terminal curl requests for both GitHub
metadata and the redirected package while the extension reported only fetch failed.
This does not prove a specific proxy/DNS/TLS cause in the extension environment.

The release owner keeps all canonical official-source, stable-version, asset-name,
uploaded-state, size and no-downgrade checks. Rejected Node fetch calls on Linux
can use an argument-array curl transport with HTTPS-only redirects, certificate
verification, bounded output and deadlines. HTTP failures and invalid release
metadata do not trigger a validation bypass or fallback to a pinned old release.
Each stage gets a separate request timeout. Neither transport mutates configuration.

Errors identify release_metadata or release_asset and retain safe Node cause codes
plus curl exit classification, never raw curl stderr/proxy credentials or signed
redirect addresses. curl ignores curlrc files; standard environment proxy variables
remain available, with no global proxy/certificate/config changes.

Fixture tests cover network fallback, HEAD redirects without package download,
HTTP rejection, bounded safe arguments, failure diagnostics and unchanged official
release validation. WSL forced-Node-failure testing retrieved official metadata but
package verification timed out in this environment (curl 28). End-to-end success
in the user's extension environment is not yet verified; this change must not
claim unreachable downloads are available or modify config after both paths fail.
