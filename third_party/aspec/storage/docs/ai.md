# AI agent notes

## Purpose
File storage with local/S3 drivers, quotas, signed URLs and tus uploads.

## Use when
Uploads, downloads, integrity or resumable uploads are needed.

## Avoid when
You only need a one-off `fs.writeFile` without metadata or quotas.

## Prerequisites
Node >= 22.13. Optional AWS SDK peers for S3.

## Integration steps
1. Choose driver (`createLocalDriver` or `createS3Driver`)
2. Choose metadata store (memory or SQL migrate + store)
3. `createStorage({ driver, metadata, signingSecret })`
4. Optional HTTP adapter with `publicBaseUrl`

## Configuration
See configure.md.

## Verification
`pnpm --filter @aspec/storage test` with Postgres and S3 env vars.

## Common mistakes
Missing signingSecret for local signed URLs; mounting body parsers before upload middleware; skipping migrate for SQL.

## Uninstall
See uninstall.md.
