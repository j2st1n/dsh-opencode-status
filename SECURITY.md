# Security notes

- The OpenCode API key is stored only in the host credentials store (`OPENCODE_GO_API_KEY` or custom key ref); API responses never return the full key.
- Host routes are local to the DSH web server (`Cache-Control: no-store`) and return allowlisted usage fields only.
- Host routes are guarded against untrusted origins. All routes are registered with `kind: 'exact'`, which bypasses the host's `/api` prefix admission, so the plugin applies an equivalent fence itself: the Host header must be loopback, the listener bind address, or listed in `connection.trustedHosts`; `Sec-Fetch-Site: cross-site` is rejected; a supplied Origin must match the same authority. Forged Host (DNS rebinding), cross-site and mismatched-origin requests get 403 instead of data. Write requests additionally require `application/json` (415 otherwise) and are fenced before the body is parsed.
  - The fence tolerates a missing `connection` service: a real host returns `null` from `ctx.get('connection')`, in which case the plugin falls back to its equivalent local implementation and still rejects untrusted origins with 403 (regression covered by tests).
  - Boundary: the fence blocks **browser origins** and DNS rebinding only. It does **not** authenticate same-host processes that can reach the loopback port.
- Upstream requests use a 10-second `AbortController` timeout, and successful usage responses are cached for 30 seconds to reduce gateway load.
