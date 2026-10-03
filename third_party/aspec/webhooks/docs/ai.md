# AI agent guide

## Purpose

Secure outbound webhook delivery and inbound signature verification.

## Use when

You need signed event delivery to customer URLs, or to verify Standard/GitHub/Stripe/HMAC
webhooks.

## Avoid when

You only need transactional email (use `@aspec/notifications`).

## Integration steps

1. Install and set `WEBHOOKS_ENCRYPTION_KEY`.
2. `createWebhooks({ store, security })`.
3. `createSubscription` then `publish`.
4. Optionally register `createDeliveryJobHandler`.
5. For inbound: `verifyWebhookSignature` or framework middleware with raw body.

## Verification

```bash
pnpm --filter @aspec/webhooks test
```

## Common mistakes

- Forgetting the encryption key
- Allowing private URLs in production (`allowHosts`)
- Verifying after JSON parsing without preserving raw body
