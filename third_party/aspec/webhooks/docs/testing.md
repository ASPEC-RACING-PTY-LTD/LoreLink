# Testing

Inject `clock`, `generateId`, `security.ssrf.lookup` and `allowHosts: ['127.0.0.1']` with
`requireHttps: false` for local servers. Prove SSRF blocks loopback without the allowlist.
Use Standard Webhooks published vectors for signing tests.
