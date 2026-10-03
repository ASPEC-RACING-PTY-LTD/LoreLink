# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| HTML injection in templates | HTML mode escapes by default; raw output needs `{{{ }}}` |
| Email header injection | Subjects strip CR/LF; addresses validated |
| Credential leakage | SMTP passwords and DKIM keys never logged; errors omit secrets |
| Preference bypass | Mandatory categories cannot be disabled |
| Authz on inbox API | Callers must supply `resolveUser`; no anonymous access |
| SSRF via webhook/Slack providers | HTTPS required unless `allowInsecureLocal` is set for development |
| Oversized bodies | JSON body limit (default 64 KiB) on routers |

## Secure defaults

- TLS certificate verification on for SMTP
- STARTTLS available; prefer `requireTLS` in production
- Content cleared from delivery records after success/failure (`retainContent: 'until-complete'`)
- Constant-time comparisons are not required for template rendering; secrets stay out of templates

## Operations

Store SMTP credentials in a secret manager. Rotate DKIM keys independently of SMTP auth.
Purge old history with `purge(before)` on a schedule.
