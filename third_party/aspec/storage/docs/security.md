# Security

Threats: path traversal, type spoofing, quota abuse, unsigned URL access, SSRF via S3 endpoints. Defaults: key validation, magic-byte checks, scriptable types blocked, constant-time HMAC verify, private visibility, authorize/permissions optional but recommended. Never log signing secrets.
