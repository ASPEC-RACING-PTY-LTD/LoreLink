# Testing

Inject a clock, id generator and `sleep` that resolves immediately. Use
`createMemoryStore()` for unit tests. For SMTP, point at Mailpit or an in-process
`smtp-server`. Assert deliveries with `listDeliveries` and Mailpit's HTTP API.

```ts
const service = createNotifications({
  store: createMemoryStore(),
  channels: { email: createEmailChannel(fakeTransport) },
  clock: { now: () => 1_700_000_000_000 },
  generateId: () => 'fixed-id',
  sleep: async () => {},
  random: () => 0,
});
```

Store contract tests should run against memory, SQLite (`node:sqlite`) and PostgreSQL
when `ASPEC_TEST_POSTGRES_URL` is set.
