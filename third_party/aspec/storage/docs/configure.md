# Configure

`createStorage({ driver, metadata, validation, quotas, authorize|permissions, signingSecret, logger, clock, generateId, uploadSessionTtlMs, keyPrefix })`.

Validation defaults: maxBytes 25 MiB, type consistency on, scriptable types rejected unless allowed. Quotas: per-owner and per-tenant byte/file limits. Env: `STORAGE_SIGNING_SECRET`, `STORAGE_ROOT`, `STORAGE_S3_*`.
