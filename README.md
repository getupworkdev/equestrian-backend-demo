# Equestrian platform backend: the foundation

A Supabase/PostgreSQL backend foundation for a mobile platform where one person can be the **owner of one horse and the trainer of another**, with a Bluetooth sensor that records readings offline. Written as versioned migrations and proven by 22 permission and sync tests that run in-process, with no Supabase account or Docker.

```bash
npm install
npm test        # 22 tests, ~3 s
```

Everything here is fictional and generic: no client code, data or brand.

## What it shows

### One permission check, used everywhere

`app.has_horse_role(horse_id, roles[])` and `app.can_read_horse(horse_id)` in [`0001_foundation.sql`](supabase/migrations/0001_foundation.sql) are the only places permissions are decided. Every RLS policy calls them, every write function calls them. When the rules change (say, a stable manager gains write access), they change in one function and the test suite says what else moved.

| Role on a horse | Read | Log training | Grant roles | Register sensor |
|---|---|---|---|---|
| owner | yes | yes | yes | yes |
| trainer | yes | yes | no | no |
| caretaker | yes | no | no | no |
| stable manager (horse boarded at their stable) | yes | no | no | no |
| nobody | no | no | no | no |

[`tests/permissions.test.ts`](tests/permissions.test.ts) runs the scenario from the brief: Anna owns Storm and trains Luna; Ben owns Luna; Carl is Storm's caretaker; Dana manages the stable Luna is boarded at; Eve is nobody. Each test is a sentence like "caretaker Carl can read Storm but cannot log training", run as that user under RLS.

### A versioned API the app teams can build against

Clients never touch `app.*` tables directly: no insert, update or delete grants at all. They read `api_v1.*` views (which run under the caller's RLS) and call `api_v1.*` SQL functions for every write ([`0002_api_v1.sql`](supabase/migrations/0002_api_v1.sql)). Each function re-checks permissions itself and raises a named error (`forbidden: only an owner or trainer can log training`) that an app can map to a message. The contract is the SQL file, so iOS and Android can code against it before the backend is finished, and `api_v2` can exist beside `api_v1` later.

The tests also prove the policies can't be bypassed: direct writes to `app.*` are refused, a training-log id can't be re-pointed at another horse through the upsert, and the last owner can't remove themselves.

### Offline-first sync and the sensor ([`0003_sensors_and_sync.sql`](supabase/migrations/0003_sensors_and_sync.sql))

- **Idempotent batch upload.** The phone buffers readings and uploads `{seq, measured_at, temperature, humidity}` batches; `seq` is the device's own counter. Re-sending a batch after a timeout inserts nothing twice; the function returns `accepted`, `duplicates` and the highest `seq` stored, which becomes the phone's upload watermark. Batches over 5,000 are refused.
- **Monthly partitions**, created on demand by the upload function (in production a scheduled job creates them ahead).
- **Delta pull with tombstones.** `api_v1.changes_since(ts)` returns every horse, training log and device the caller may read that changed after the watermark, including deletions (soft deletes keep the row and set `deleted_at`, so a device that was offline learns about them). The views never show tombstones.
- **Client-generated ids** on training logs, so an offline write can be retried safely.

[`tests/sync.test.ts`](tests/sync.test.ts) covers the duplicate batch, the partially overlapping batch, partition creation, the stranger who can't upload, and the offline-then-sync sequence with an update and a deletion.

## How the tests run without Supabase

[`tests/db.ts`](tests/db.ts) starts an in-process Postgres ([PGlite](https://pglite.dev)), applies the migrations in order, and runs each test block as a signed-in user the way PostgREST does: `set local role authenticated` plus `request.jwt.claims` carrying the user id. `auth.uid()` is shimmed to read that claim, so the same SQL runs on Supabase unchanged. CI runs the suite on every push ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## What is not here

Edge Functions for external integrations (webhook verification, idempotency keys, outbox), the staging/production deployment pipeline, and the QR product passport: each is a work package of its own, and each would start the same way, with the contract in SQL and the permission tests first.
