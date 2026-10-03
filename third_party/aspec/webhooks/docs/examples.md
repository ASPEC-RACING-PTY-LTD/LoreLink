# Examples

## Rotate secrets

```ts
const { secret } = await webhooks.rotateSecret(subId, { expiresInMs: 86_400_000 });
// Give consumers the new secret; old secrets remain valid until expiry
await webhooks.removeExpiredSecrets(subId);
```

## Incoming Express route

```ts
import { preserveRawBody, verifyWebhookMiddleware } from '@aspec/webhooks/express';

app.post('/hooks', preserveRawBody(), verifyWebhookMiddleware({
  scheme: 'standard',
  secrets: [process.env.INCOMING_WEBHOOK_SECRET!],
}), (req, res) => {
  res.json({ ok: true, id: req.webhook?.id });
});
```
