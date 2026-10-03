# @aspec/storage

File storage for local filesystems and S3-compatible object stores: streaming uploads and downloads, metadata, validation, quotas, access control, signed URLs, integrity checks and tus 1.0 resumable uploads.

## Install

```bash
aspec add aspec/storage
pnpm add @aspec/storage
```

## Quick start

```ts
import { createStorage } from '@aspec/storage';
import { createLocalDriver } from '@aspec/storage/local';
import { createMemoryMetadataStore } from '@aspec/storage/memory';

const storage = createStorage({
  driver: createLocalDriver({ root: './data/files' }),
  metadata: createMemoryMetadataStore(),
  signingSecret: process.env.STORAGE_SIGNING_SECRET!,
});

const file = await storage.upload({
  body: Buffer.from('hello'),
  filename: 'hello.txt',
  contentType: 'text/plain',
});
```

Docs live under `docs/`.
