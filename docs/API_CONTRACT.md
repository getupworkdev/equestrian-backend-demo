# API contract: `api_v1`

Generated from the database by `npm run contract` (comments in `supabase/migrations/0006_api_docs.sql`, everything else from the catalogue). CI fails when this file and the migrations disagree, so the contract the app developers read is always the one that runs.

Reads are views queried through the Supabase Data API (`/rest/v1/<view>` with `Accept-Profile: api_v1`); every row is filtered by Row Level Security. Writes are SQL functions (`/rest/v1/rpc/<name>` with `Content-Profile: api_v1`). Errors are raised with a readable message and a SQLSTATE code the apps can switch on.

6 views, 13 functions.

## Reads (views)

### `horses`

Horses the caller may see: as owner, trainer or caretaker, or as manager of the stable where the horse is boarded. my_role is null for stable-manager visibility.

Readable by: signed-in users.

| Column | Type |
| --- | --- |
| `id` | uuid |
| `name` | text |
| `stable_id` | uuid |
| `created_at` | timestamp with time zone |
| `updated_at` | timestamp with time zone |
| `my_role` | app.horse_role |

### `my_products`

Products registered to the caller, with the horse they are attached to.

Readable by: signed-in users.

| Column | Type |
| --- | --- |
| `id` | uuid |
| `qr_code` | text |
| `product_type` | text |
| `model` | text |
| `horse_id` | uuid |
| `registered_at` | timestamp with time zone |

### `sensor_devices`

Bluetooth sensors registered to horses the caller may see.

Readable by: signed-in users.

| Column | Type |
| --- | --- |
| `id` | uuid |
| `horse_id` | uuid |
| `serial` | text |
| `created_at` | timestamp with time zone |
| `updated_at` | timestamp with time zone |

### `sensor_readings`

Temperature and humidity readings for sensors the caller may see. Filter by device_id and measured_at.

Readable by: signed-in users.

| Column | Type |
| --- | --- |
| `device_id` | uuid |
| `seq` | bigint |
| `measured_at` | timestamp with time zone |
| `temperature` | numeric(5,2) |
| `humidity` | numeric(5,2) |

### `stables`

Stables the caller is a member of.

Readable by: signed-in users.

| Column | Type |
| --- | --- |
| `id` | uuid |
| `name` | text |
| `created_at` | timestamp with time zone |
| `updated_at` | timestamp with time zone |

### `training_logs`

Training logs for every horse the caller may see. Deleted logs are hidden; sync learns about deletions through changes_since.

Readable by: signed-in users.

| Column | Type |
| --- | --- |
| `id` | uuid |
| `horse_id` | uuid |
| `author_id` | uuid |
| `logged_on` | date |
| `minutes` | integer |
| `notes` | text |
| `created_at` | timestamp with time zone |
| `updated_at` | timestamp with time zone |

## Writes and calls (functions)

### `authorize_horse_media(p_horse_id uuid, p_action text)`

Returns: `text`. Callable by: signed-in users.

Called by the horse-media-url Edge Function with the user's token. read: anyone who may see the horse; write: owner or trainer. Returns the Storage folder; the function then signs a short-lived URL for one file in it.

| Error message | SQLSTATE |
| --- | --- |
| forbidden: cannot view this horse's media | 42501 |
| forbidden: only an owner or trainer can upload media | 42501 |
| invalid action: use read or write | 22023 |

### `changes_since(p_since timestamp with time zone)`

Returns: `TABLE(entity text, id uuid, updated_at timestamp with time zone, deleted boolean, data jsonb)`. Callable by: signed-in users.

Delta sync. Everything the caller may see that changed after the watermark, including deletions (deleted = true, data = null). Use the largest updated_at returned as the next watermark.

### `create_horse(p_name text, p_stable_id uuid DEFAULT NULL::uuid)`

Returns: `uuid`. Callable by: signed-in users.

Creates a horse, optionally boarded at a stable the caller belongs to; the caller becomes its owner. Returns the horse id.

| Error message | SQLSTATE |
| --- | --- |
| not_authenticated | 28000 |
| forbidden: not a member of that stable | 42501 |

### `create_stable(p_name text)`

Returns: `uuid`. Callable by: signed-in users.

Creates a stable; the caller becomes its manager. Returns the stable id.

| Error message | SQLSTATE |
| --- | --- |
| not_authenticated | 28000 |

### `delete_training_log(p_id uuid)`

Returns: `void`. Callable by: signed-in users.

Owner or trainer. Soft-deletes a training log (other devices learn about it through changes_since). Deleting twice is not an error.

| Error message | SQLSTATE |
| --- | --- |
| forbidden | 42501 |

### `passport(p_qr_code text)`

Returns: `jsonb`. Callable by: anyone (signed in or not).

Scan a product QR code. Anyone, signed in or not, gets the public passport (what it is, materials, care, batch, whether it is registered). The registered owner also gets the owner section: horse, registration date and ownership history.

| Error message | SQLSTATE |
| --- | --- |
| not_found: unknown product code | P0002 |

### `register_product(p_qr_code text, p_horse_id uuid DEFAULT NULL::uuid)`

Returns: `uuid`. Callable by: signed-in users.

Registers a scanned product to the caller, optionally attached to a horse where the caller is owner or trainer. Registering again as the same owner is a safe retry. Writes a product.registered outbox event.

| Error message | SQLSTATE |
| --- | --- |
| not_authenticated | 28000 |
| not_found: unknown product code | P0002 |
| forbidden: only an owner or trainer can attach a product to this horse | 42501 |
| conflict: product is registered to someone else; ask them to transfer it | 23505 |

### `register_sensor(p_horse_id uuid, p_serial text)`

Returns: `uuid`. Callable by: signed-in users.

Owner only. Registers a Bluetooth sensor (by serial) to a horse. Registering the same serial to the same horse again is safe. Returns the device id.

| Error message | SQLSTATE |
| --- | --- |
| forbidden: only an owner can register a sensor | 42501 |
| conflict: serial registered to another horse | 23505 |

### `revoke_horse_role(p_horse_id uuid, p_user_id uuid)`

Returns: `void`. Callable by: signed-in users.

Owner only. Removes a user's role on a horse. A horse always keeps at least one owner.

| Error message | SQLSTATE |
| --- | --- |
| forbidden: only an owner can revoke roles | 42501 |
| conflict: a horse must keep at least one owner | 23514 |

### `set_horse_role(p_horse_id uuid, p_user_id uuid, p_role app.horse_role)`

Returns: `void`. Callable by: signed-in users.

Owner only. Grants or changes a user's role on a horse (owner, trainer, caretaker).

| Error message | SQLSTATE |
| --- | --- |
| forbidden: only an owner can set roles | 42501 |

### `transfer_product(p_product_id uuid, p_to_user uuid)`

Returns: `void`. Callable by: signed-in users.

Current owner only. Transfers a product to another user and clears the horse link. Writes a product.transferred outbox event.

| Error message | SQLSTATE |
| --- | --- |
| forbidden: only the registered owner can transfer this product | 42501 |
| not_found: unknown user | P0002 |

### `upload_readings(p_device_id uuid, p_readings jsonb)`

Returns: `TABLE(accepted integer, duplicates integer, last_seq bigint)`. Callable by: signed-in users.

Owner, trainer or caretaker. Uploads a batch of up to 5,000 readings [{seq, measured_at, temperature, humidity}]. Re-sending readings already stored is safe: returns how many were new, how many duplicates, and the highest seq stored (the app's upload watermark).

| Error message | SQLSTATE |
| --- | --- |
| forbidden: cannot upload for this device | 42501 |
| readings must be an array | 22023 |
| batch too large (max 5000) | 22023 |

### `upsert_training_log(p_id uuid, p_horse_id uuid, p_logged_on date, p_minutes integer, p_notes text DEFAULT NULL::text)`

Returns: `uuid`. Callable by: signed-in users.

Owner or trainer. Creates or updates a training log. The id is generated by the app, so an offline retry never creates a duplicate; an id cannot be moved to another horse.

| Error message | SQLSTATE |
| --- | --- |
| forbidden: only an owner or trainer can log training | 42501 |
