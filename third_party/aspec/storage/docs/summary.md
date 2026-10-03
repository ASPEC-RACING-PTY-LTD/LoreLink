# @aspec/storage

Reusable file storage with local and S3-compatible drivers. Streaming uploads compute SHA-256 and enforce size limits while writing. Metadata lives in memory or SQL (`storage_` prefix). Supports validation (magic bytes, extensions), quotas, access control, HMAC or S3 presigned URLs, integrity verification and tus 1.0 resumable uploads.
