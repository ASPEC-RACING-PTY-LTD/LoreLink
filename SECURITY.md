# Security

LoreLink can hold write credentials for many repositories. Treat it as security-sensitive.

## Reporting

Please report vulnerabilities privately to the maintainers. Do not open a public issue for an unfixed security defect.

## Practices

- Secrets are encrypted at rest with the instance key (`$LORELINK_DATA_DIR/instance.key`).
- Provider credentials must never appear in documentation pages, logs, or audit metadata.
- Session cookies are httpOnly. Cookie-authenticated mutations require a same-origin check.
- Passwords are stored with argon2id.
- Capability checks are enforced on the server. The UI only hides what the API already denies.

## Backups

Back up PostgreSQL and `instance.key` together. Losing the key means stored credentials cannot be recovered.
