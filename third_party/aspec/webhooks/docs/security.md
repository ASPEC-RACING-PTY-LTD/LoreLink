# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| SSRF | HTTPS default, DNS resolve + private range block, IP pin, no redirects |
| Secret leakage | Plaintext only at create/rotate; AES-256-GCM at rest; redacted in APIs/logs |
| Tampering | Standard Webhooks HMAC-SHA256; constant-time compares |
| Replay | Seen-id store with TTL |
| Privilege escalation | Admin routers require `resolveSubject` and optional PermissionChecker |

## Secure defaults

`requireHttps: true`, default ports only, response body truncation, secrets never logged.
