// Called on a schedule (pg_cron + pg_net, every minute). Claims a batch from
// app.outbox, delivers each event to the external system with a signature and
// an idempotency key, and records the outcome. Failed events come back later
// with exponential backoff; after 8 attempts they are marked dead for a human.
// Secrets: OUTBOX_TARGET_URL, OUTBOX_SIGNING_SECRET, CRON_SECRET. SUPABASE_DB_URL is provided.
import postgres from 'npm:postgres@3.4.5';
import { deliverAll, idempotencyKey, type OutboxRow } from '../_shared/dispatch.ts';
import { signatureHeader } from '../_shared/signature.ts';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
const target = Deno.env.get('OUTBOX_TARGET_URL')!;
const signingSecret = Deno.env.get('OUTBOX_SIGNING_SECRET')!;

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });

  const rows = await sql<OutboxRow[]>`select id, topic, payload, attempts from app.claim_outbox(50)`;
  const outcomes = await deliverAll(rows, async (row) => {
    const body = JSON.stringify({ id: idempotencyKey(row), topic: row.topic, data: row.payload });
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey(row),
        'x-signature': await signatureHeader(signingSecret, body, Math.floor(Date.now() / 1000)),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status };
  });

  for (const o of outcomes) {
    if (o.result === 'delivered') await sql`select app.mark_outbox_delivered(${o.id})`;
    else await sql`select app.mark_outbox_failed(${o.id}, ${o.error})`;
  }
  return Response.json({ claimed: rows.length, delivered: outcomes.filter((o) => o.result === 'delivered').length });
});
