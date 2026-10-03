# Troubleshooting

Organised by error code.

## `NOTIFICATIONS_INVALID_CONFIG`

An option failed validation (missing store, bad channel name, invalid retry policy).
Check the error message for the option path.

## `NOTIFICATIONS_INVALID_INPUT`

Request or `notify()` input is invalid (category pattern, missing template/content,
oversized body). Fix the caller payload.

## `NOTIFICATIONS_NOT_FOUND`

In-app notification or delivery id does not exist for that user.

## `NOTIFICATIONS_PREFERENCE_MANDATORY`

Attempted to disable a mandatory category (security, account, or any category marked
`mandatory: true`). Those channels stay enabled.

## `NOTIFICATIONS_CHANNEL_NOT_FOUND`

`notify({ channels })` named a channel that was not registered.

## `NOTIFICATIONS_TEMPLATE_NOT_FOUND` / `NOTIFICATIONS_TEMPLATE_VARIABLE_MISSING` / `NOTIFICATIONS_TEMPLATE_SYNTAX`

Template id missing, required variable absent, or malformed template syntax.

## `NOTIFICATIONS_DELIVERY_FAILED`

Provider failed permanently, enqueue failed, or the Mailer path saw a failed delivery.
Inspect `listDeliveries` / `getDelivery` for `errorClass` and `errorCode`. Transient
SMTP 4xx errors retry automatically.

## `NOTIFICATIONS_UNAUTHENTICATED`

HTTP router could not resolve a user. Provide `resolveUser`.

## `NOTIFICATIONS_PROVIDER_ERROR`

Thrown by providers (SMTP, Slack, webhook). Check `errorClass` (`transient` vs
`permanent`) and `providerCode`.
