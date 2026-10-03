# Uninstall

1. Unmount notification routers and unregister the `notifications.deliver` job handler.
2. Remove `createNotifications` setup and environment variables (`SMTP_*`,
   `NOTIFICATIONS_EMAIL_FROM`).
3. Uninstall the package: `pnpm remove @aspec/notifications` (and optional peers).
4. Drop SQL tables if you used the SQL store:

```sql
DROP TABLE IF EXISTS notifications_delivery_attempts;
DROP TABLE IF EXISTS notifications_deliveries;
DROP TABLE IF EXISTS notifications_preferences;
DROP TABLE IF EXISTS notifications_items;
DROP TABLE IF EXISTS notifications_schema_migrations;
```

Data is not dropped automatically.
