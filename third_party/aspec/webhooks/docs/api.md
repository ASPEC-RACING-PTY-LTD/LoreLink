# API

## `@aspec/webhooks`

| Export | Description |
|--------|-------------|
| `createWebhooks(options)` | Outgoing webhook service |
| `createDeliveryJobHandler(service)` | JobQueue handler for `webhooks.deliver` |
| `DELIVER_JOB_NAME` | `"webhooks.deliver"` |
| `verifyWebhookSignature(body, headers, options)` | Incoming verification |
| `signStandardWebhooks` / `generateWebhookSecret` | Signing helpers |
| `resolveSafeUrl` | SSRF-checked URL resolution |
| `WebhooksError` / `isWebhooksError` | Errors |

### WebhooksService

`createSubscription`, `updateSubscription`, `getSubscription`, `listSubscriptions`,
`deleteSubscription`, `rotateSecret`, `removeExpiredSecrets`, `enableSubscription`,
`disableSubscription`, `publish`, `processDeliveryJob`, `redeliver`, `redeliverFailed`,
`ping`, `listDeliveries`, `getDelivery`, `startScheduler`, `stopScheduler`, `close`.

## Subpaths

`./memory`, `./sql`, `./express`, `./fastify`, `./hono`, `./fetch`.
