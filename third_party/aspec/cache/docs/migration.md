# Migrations

This module has no persistent SQL schema. Memory state is process-local. Redis keys use the configured prefix (default `aspec:cache:`). Flush that prefix if you need to clear cached data during an upgrade.
