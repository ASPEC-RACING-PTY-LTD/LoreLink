# Troubleshooting

## `CACHE_UNAVAILABLE`

The backend failed or the circuit breaker is open and `failOpen` is false. Check Redis connectivity, raise `timeoutMs`, or keep `failOpen: true` (default).

## `CACHE_KEY_INVALID`

Keys must be non-empty and use letters, digits and `:._@/-`. Use `key(...)` to build them.

## `CACHE_SERIALIZE`

Value could not be JSON-encoded. Provide a custom `serializer` or store a plain JSON-safe value.

## `CACHE_CLOSED`

The cache was closed. Create a new instance.

## High miss rate after deploy

Namespace generations or TTL jitter may have invalidated entries. Expected after `invalidateNamespace()`.
