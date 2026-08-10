# Showbase storage

Showbase keeps deployable application code separate from durable customer data.
Set `SHOWBASE_STORAGE_ROOT` to the durable root used by the running service.

## Layout

```text
showbase-storage/
  config/                       Global company registry and user access data
  companies/
    AVPL/
      data/                     CSV/JSON operational state and event records
      documents/                Event files, invoices, claims, and receipts
      media/                    Maintenance media and container photos
      branding/                 Company logos and PDF branding assets
      exports/                  Reserved for durable generated exports
    TSC/
      ...                       The same isolated layout for TSC
  system/data/                  Owner-only system records
  runtime/logs/                 Process and startup logs
  storage-layout.json           Migration/layout manifest
```

Company paths are resolved from the authenticated company context. Upload and
media resolvers reject traversal outside the selected company's storage area.

## Local migration

Stop Showbase before taking the copy, then run:

```powershell
.\.venv\Scripts\python.exe migrate_storage.py
```

The command copies and byte-verifies every file. It does not delete the legacy
`app_data/` or `companies/` folders. Existing logical attachment paths remain
unchanged, and the application retains read fallback to the legacy locations.
Once `storage-layout.json` exists, the migration refuses to overwrite the
target unless `--force` is supplied explicitly.

## Render

Render's normal filesystem is ephemeral. Attach a persistent disk at
`/var/data`, then configure:

```text
SHOWBASE_STORAGE_ROOT=/var/data/showbase
```

Only paths beneath the disk mount survive restarts and deploys. Keep structured
business records in Render Postgres via `DATABASE_URL`; the storage root remains
responsible for uploaded documents and media.

An attached Render disk is available to one service instance, so this layout is
appropriate for a single-instance deployment. Before horizontal scaling, move
`documents/`, `media/`, and durable exports to object storage behind the same
path/provider interface. See [Render persistent disks](https://render.com/docs/disks).
