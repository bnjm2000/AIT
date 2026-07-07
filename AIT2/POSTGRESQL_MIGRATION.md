# PostgreSQL migration

The application uses PostgreSQL when `DATABASE_URL` is configured. Without it,
the existing CSV backend remains active, which provides a straightforward
rollback path.

## What is stored in PostgreSQL

- shared users;
- per-company inventory, containers, events, system logs, clients, and
  departments;
- event history snapshots;
- company and global revision counters used to reject stale concurrent writes;
- migration fingerprints and verification results.

Uploaded media, event attachments, company logos, and PDF branding files remain
on disk because they are binary files rather than relational records.

## Safe copy and verification

Run a read-only inventory first:

```powershell
$env:DATABASE_URL = 'postgresql://showbase_user:password@127.0.0.1:5432/showbase_db'
python migrate_to_postgres.py
```

Apply an idempotent replacement import:

```powershell
python migrate_to_postgres.py --apply
```

The command exits unsuccessfully if any PostgreSQL row count differs from its
CSV source count. Each successful company import is recorded in
`aim_migration_runs` with a source fingerprint.

## Cutover

1. Stop the Showbase web process so CSV files cannot change during the final copy.
2. Run `python migrate_to_postgres.py --apply` once more.
3. Copy `.env.example` to `.env` and put the real `DATABASE_URL` in `.env`.
4. Install `requirements.txt` and restart Showbase.
5. Confirm login, company switching, inventory, events, containers, clients,
   maintenance, and one reversible test edit.

## Rollback

Stop Showbase, remove or rename `.env`, and restart. The application will return to
the CSV backend. Keep the CSV folders read-only and unchanged after cutover so
they remain a reliable rollback snapshot.
