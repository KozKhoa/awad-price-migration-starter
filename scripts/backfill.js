// Backfill menu_items.price_vnd from menu_items.price in small batches.
// Each batch runs in its own short transaction so traffic can proceed concurrently.
// Idempotent: selects rows WHERE price_vnd IS NULL OR price_vnd <> round(price * 1000).
import { open, DB_PATH } from '../src/db.js';

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 500);
const DELAY_MS = Number(process.env.DELAY_MS ?? 15);
const db = open();

console.log(`Starting backfill on ${DB_PATH} (batch size: ${BATCH_SIZE}, delay: ${DELAY_MS}ms)...`);

const selectBatch = db.prepare(`
  SELECT id, price FROM menu_items
  WHERE price_vnd IS NULL OR price_vnd <> CAST(round(price * 1000) AS INTEGER)
  LIMIT ?
`);

const updateItem = db.prepare(`
  UPDATE menu_items
  SET price_vnd = CAST(round(price * 1000) AS INTEGER)
  WHERE id = ?
`);

const countRemaining = db.prepare(`
  SELECT count(*) AS n FROM menu_items
  WHERE price_vnd IS NULL OR price_vnd <> CAST(round(price * 1000) AS INTEGER)
`);

const totalInitial = countRemaining.get().n;
console.log(`Initial rows missing or inconsistent price_vnd: ${totalInitial}`);

if (totalInitial === 0) {
  console.log('All rows already have consistent price_vnd. Nothing to backfill.');
  process.exit(0);
}

let totalProcessed = 0;
const t0 = Date.now();

while (true) {
  const rows = selectBatch.all(BATCH_SIZE);
  if (rows.length === 0) break;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      updateItem.run(row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Error during backfill batch transaction:', err);
    throw err;
  }

  totalProcessed += rows.length;
  const remaining = countRemaining.get().n;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Backfilled ${totalProcessed}/${totalInitial} items (${remaining} remaining) · ${elapsed}s`);

  if (DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
}

const finalRemaining = countRemaining.get().n;
console.log(`Backfill finished. Processed: ${totalProcessed}. Remaining missing: ${finalRemaining}.`);
if (finalRemaining > 0) {
  console.error('Backfill ended with un-backfilled rows remaining!');
  process.exit(1);
}
