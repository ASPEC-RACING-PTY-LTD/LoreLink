# API

- `createStorage` / `Storage`: upload, download, get, list, update, delete, deleteByOwner, usage, verify, createSignedUrl, verifySignedUrl, resumable session APIs, cleanupExpired, checkHealth
- Drivers: `createLocalDriver`, `createS3Driver`
- Metadata: `createMemoryMetadataStore`, `createSqlMetadataStore`, `migrate`
- HTTP: `createStorageHttpHandler`, adapters under `/express`, `/fastify`, `/hono`, `/fetch`
- Helpers: sanitizeFilename, validateKey, sniffContentType, StorageError
