// POST /functions/v1/horse-media-url  { horse_id, file, action: 'read' | 'write' }
// The database decides (api_v1.authorize_horse_media, same permission check as
// every policy), then this function signs a short-lived Storage URL with the
// service key. The bucket itself stays private: no client can list or read it.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'horse-media';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const auth = req.headers.get('authorization');
  if (!auth) return new Response('sign in first', { status: 401 });

  const { horse_id, file, action } = await req.json().catch(() => ({}));
  if (typeof file !== 'string' || !/^[\w.-]{1,120}$/.test(file) || file.startsWith('.')) {
    return new Response('invalid file name', { status: 400 });
  }

  // As the caller: RLS and the permission check apply.
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { authorization: auth } },
    db: { schema: 'api_v1' },
  });
  const { data: folder, error } = await asUser.rpc('authorize_horse_media', { p_horse_id: horse_id, p_action: action });
  if (error) return Response.json({ error: error.message }, { status: error.message.startsWith('forbidden') ? 403 : 400 });

  // As the service: sign one object inside the folder the database allowed.
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const path = `${folder}${file}`;
  const storage = admin.storage.from(BUCKET);
  const signed = action === 'write'
    ? await storage.createSignedUploadUrl(path)
    : await storage.createSignedUrl(path, 60);
  if (signed.error) return Response.json({ error: signed.error.message }, { status: 400 });
  return Response.json({ path, url: signed.data.signedUrl, expires_in: action === 'write' ? 7200 : 60 });
});
