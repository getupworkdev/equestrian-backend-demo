// Outbox delivery rules, kept free of I/O so they are unit-tested.
// The Edge Function claims rows (app.claim_outbox), calls deliverAll with a
// real HTTP sender, then reports each outcome back to the database.

export type OutboxRow = { id: number; topic: string; payload: unknown; attempts: number };
export type SendResult = { status: number } | { error: string };
export type Outcome = { id: number; result: 'delivered' } | { id: number; result: 'failed'; error: string };

/** Every delivery carries the outbox id as the idempotency key, so a receiver that
 *  already processed it can safely answer 2xx or 409 to a repeat. */
export const idempotencyKey = (row: OutboxRow) => `outbox-${row.id}`;

export function classify(row: OutboxRow, res: SendResult): Outcome {
  if ('error' in res) return { id: row.id, result: 'failed', error: `network: ${res.error}` };
  if ((res.status >= 200 && res.status < 300) || res.status === 409) return { id: row.id, result: 'delivered' };
  return { id: row.id, result: 'failed', error: `http ${res.status}` };
}

/** In id order, one at a time: events about the same product keep their order. */
export async function deliverAll(rows: OutboxRow[], send: (row: OutboxRow) => Promise<SendResult>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    let res: SendResult;
    try {
      res = await send(row);
    } catch (e) {
      res = { error: e instanceof Error ? e.message : String(e) };
    }
    out.push(classify(row, res));
  }
  return out;
}
