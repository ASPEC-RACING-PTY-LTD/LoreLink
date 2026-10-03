# Examples

```ts
await queue.add('digest', {}, { delayMs: 60_000, priority: 10 });
createScheduler({
  queue,
  schedules: [{ id: 'hourly', name: 'tick', cron: '0 * * * *' }],
}).start();
```
