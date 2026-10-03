# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Cache as secret store | Do not cache passwords, tokens or credentials |
| Poisoned cache values | Treat cache as untrusted acceleration; validate on use when needed |
| Redis exposure | Use private network TLS and ACLs; prefix keys per environment |
| Outage cascading | Default `failOpen` and circuit breaker fail to loader/DB paths |

## Defaults

`failOpen: true`, operation timeout 2s, breaker threshold 5 with 5s cool-down, JSON serializer.

## Operations

Separate Redis databases or prefixes per environment. Monitor `stats().errors` and health checks. Prefer short TTLs for authorization data.
