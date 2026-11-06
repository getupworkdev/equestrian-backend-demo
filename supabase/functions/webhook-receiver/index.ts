// POST /functions/v1/webhook-receiver?provider=<name>
// 1. verify the HMAC signature on the RAW body (before parsing anything)
// 2. store the event once per (provider, event id): a re-delivery gets 200 "duplicate"
//    and is not processed again
// 3. process, then mark processed_at
// Secrets: WEBHOOK_SECRET_<PROVIDER> per provider. SUPABASE_DB_URL is provided by Supabase.
import postgres from 'npm:postgres@3.4.5';
import { verifySignature } from '../_shared/signature.ts';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const provider = new URL(req.url).searchParams.get('provider') ?? '';
  if (!/^[a-z0-9_-]{1,32}$/.test(provider)) return new Response('unknown provider', { status: 400 });
  const secret = Deno.env.get(`WEBHOOK_SECRET_${provider.toUpperCase().replaceAll('-', '_')}`);
  if (!secret) return new Response('unknown provider', { status: 400 });

  const rawBody = await req.text();
  const check = await verifySignature({
    secret,
    header: req.headers.get('x-signature'),
    rawBody,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!check.ok) return new Response(`invalid signature: ${check.reason}`, { status: 401 });

  let event: { id?: string; type?: string };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('body is not JSON', { status: 400 });
  }
  if (!event.id) return new Response('event id missing', { status: 400 });

  const [{ is_new }] = await sql`select app.record_webhook(${provider}, ${event.id}, ${sql.json(event)}) as is_new`;
  if (!is_new) return Response.json({ status: 'duplicate', id: event.id });

  // Process by event.type here (each handler is idempotent on event.id), then:
  await sql`update app.inbound_webhooks set processed_at = now() where provider = ${provider} and event_id = ${event.id}`;
  return Response.json({ status: 'processed', id: event.id });
});
