# Troubleshooting

## `WEBHOOKS_INVALID_CONFIG`

Missing encryption key, bad table prefix or invalid SSRF options.

## `WEBHOOKS_INVALID_INPUT`

Bad URL, body or publish input.

## `WEBHOOKS_NOT_FOUND`

Unknown subscription or delivery id.

## `WEBHOOKS_SSRF_BLOCKED`

Destination resolves to a private, loopback, link-local, CGNAT, multicast or metadata
address, uses a non-default port, or is not HTTPS when required.

## `WEBHOOKS_SIGNATURE_INVALID` / `WEBHOOKS_TIMESTAMP_EXPIRED` / `WEBHOOKS_REPLAY`

Incoming verification failed: bad signature, skew beyond tolerance (default 5 minutes), or
replayed webhook-id.

## `WEBHOOKS_DELIVERY_FAILED`

Outbound POST failed (timeout, redirect, network). Retries apply for transient failures.
