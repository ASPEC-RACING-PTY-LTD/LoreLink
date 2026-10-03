# Summary

`@aspec/webhooks` provides secure outgoing and incoming webhook infrastructure. Outgoing
subscriptions filter events, sign payloads with Standard Webhooks (including secret
rotation), deliver with SSRF protections, retry with jitter, track history and auto-disable
failing endpoints. Incoming verification covers Standard Webhooks, GitHub, Stripe and
generic HMAC with replay protection. Admin HTTP adapters exist for Express, Fastify, Hono
and Fetch. Persistence uses memory or SQL (`webhooks_` prefix).
