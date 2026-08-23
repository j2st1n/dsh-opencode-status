# Security notes

- The OpenCode API key is stored only in the host credentials store (`OPENCODE_GO_API_KEY` or custom key ref); API responses never return the full key.
- Host routes are local to the DSH web server (`Cache-Control: no-store`) and return allowlisted usage fields only.
- Upstream requests use standard timeouts (`AbortSignal.timeout`) and multi-level caching to prevent gateway throttling.
