# MIGRATION.md — Zero-Downtime Migration Plan

**Project:** Smart-Restaurant Menu Service  
**Course:** CSC13114 — Advanced Web Application Development  
**Assignment:** IA#2 — Zero-Downtime Migration  
**Objective:** Migrate `menu_items.price` (thousands of VND, `REAL`) to `menu_items.price_vnd` (VND, `INTEGER`), then drop `price`, with zero downtime and zero failed requests across two active instances under live traffic.

---

## 1. Step-by-Step Migration Plan

| Step # & Description | Schema After Step | Code Version (Instance A / Instance B) | Exact Undo Command | Earlier Versions Safe Against Schema |
| :--- | :--- | :--- | :--- | :--- |
| **Step 0: Initial Baseline** | `001_init` (`id`, `name`, `price REAL`) | `v1` / `v1` | N/A (initial state) | `v1` |
| **Step 1: Schema Expand** | `001_init`, `002_add_price_vnd` (`id`, `name`, `price REAL`, `price_vnd INTEGER NULL`) | `v1` / `v1` | `npm run migrate:down` | `v1` (ignores new nullable column) |
| **Step 2: Rolling Deploy Dual-Write** | `001_init`, `002_add_price_vnd` | `v2` / `v2` (via rolling restart A: v1→v2, B: v1→v2) | Rolling restart to `v1`:<br>`kill <pid_B>; PORT=3002 npm start`<br>`kill <pid_A>; PORT=3001 npm start` | `v1`, `v2` |
| **Step 3: Data Backfill** | `001_init`, `002_add_price_vnd` (all rows have `price_vnd` populated) | `v2` / `v2` | `sqlite3 "$DB_PATH" "UPDATE menu_items SET price_vnd = NULL;"` (or re-run backfill) | `v1`, `v2` |
| **Step 4: Rolling Deploy Read-New** | `001_init`, `002_add_price_vnd` | `v3` / `v3` (via rolling restart A: v2→v3, B: v2→v3) | Rolling restart to `v2`:<br>`kill <pid_B>; PORT=3002 npm start`<br>`kill <pid_A>; PORT=3001 npm start` | `v1`, `v2`, `v3` |
| **Step 5: Live Rollback Drill** | `001_init`, `002_add_price_vnd` | `v2` / `v2` under traffic, then roll forward back to `v3` / `v3` | Forward restart to `v3`:<br>`kill <pid_A>; PORT=3001 npm start`<br>`kill <pid_B>; PORT=3002 npm start` | `v1`, `v2`, `v3` |
| **Step 6: Rolling Deploy Contract-Ready** | `001_init`, `002_add_price_vnd` | `v4` / `v4` (neither reads nor writes `price`) | Rolling restart to `v3`:<br>`kill <pid_B>; PORT=3002 npm start`<br>`kill <pid_A>; PORT=3001 npm start` | `v3`, `v4` (`v1`/`v2` unsafe if `v4` writes rows without `price`) |
| **Step 7: Schema Contract (Point of No Return)** | `001_init`, `002_add_price_vnd`, `003_drop_price` (`id`, `name`, `price_vnd INTEGER`) | `v4` / `v4` | **POINT OF NO RETURN** — Cannot be undone without data loss (see Section 2). | `v4` only (`v1`, `v2`, `v3` will immediately crash on missing column `price`) |

---

## 2. The Point of No Return

**Step 7 (Migration `003_drop_price.up.sql`) is the Point of No Return.**

### Why It Cannot Be Undone:
1. **Permanent Data Erasure:** When `ALTER TABLE menu_items DROP COLUMN price;` executes, SQLite physically drops the column definition and its values. Even though `003_drop_price.down.sql` executes `ALTER TABLE menu_items ADD COLUMN price REAL;`, the newly re-added column will contain `NULL` for all existing rows. Historic values in `price` are lost and cannot be recovered unless an additional data reconstruction script is run.
2. **Immediate Incompatibility with Earlier Code Versions:** Any instance running `v1`, `v2`, or `v3` relies on the physical column `price` existing in SQL statements (`SELECT id, name, price...` or `INSERT INTO menu_items (name, price...)`). Running or rolling back to `v1`, `v2`, or `v3` against this contracted schema causes immediate fatal SQLite errors:
   ```text
   ERR_SQLITE_ERROR: no such column: price
   ```
   Only `v4` is designed to operate completely independently of `price`, computing `price` on-the-fly from `price_vnd` for HTTP client responses.

---

## 3. Rollback Safety Analysis (Criterion 5)

### Why the Step 5 Rollback (`v3` → `v2`) is 100% Safe:
During Step 5, under active traffic, both instances were rolled back from `v3` to `v2`, verified with `npm run check`, and then rolled forward back to `v3`:
1. **Dual-Writing Parity:** Both `v2` and `v3` write to **both** columns (`price` and `price_vnd`) on every create and update path (`POST /menu`, `PATCH /menu/:id`).
2. **Backfill Was Complete:** Before entering `v3`, Step 3 completely populated `price_vnd` for all existing records. There were 0 NULL rows and 0 discrepancies between `price` and `price_vnd`.
3. **No Stale Reads:**
   - When an instance running `v2` handles a write, it updates both `price` and `price_vnd` synchronously. If `v3` reads the item from `price_vnd`, it sees the exact updated price.
   - When an instance running `v3` handles a write, it updates both `price` and `price_vnd` synchronously. If `v2` reads the item from `price`, it sees the exact updated price.
   - The traffic script checks for stale reads on every read following an acknowledged write (`expected.get(id) === r.data.price`). Zero stale reads occurred during this transition.
4. **Contractual Compatibility:** Both `v2` and `v3` support `price` and `priceVnd` in the HTTP API.

### Which Later Rollback Would NOT Be Safe:
1. **Rolling back after Step 6 (`v4` writes):**
   In `v4`, the code writes **only** to `price_vnd` and no longer writes to `price`. If a write occurs in `v4` and an instance is subsequently rolled back to `v2` or `v1` (which read from `price`), those older instances will read stale data or NULL for newly inserted items, failing contract checks and stale read assertions.
2. **Rolling back after Step 7 (Migration 003):**
   Once `003_drop_price` is applied, column `price` ceases to exist. Any rollback to `v1`, `v2`, or `v3` will immediately fail with `no such column: price`.

---

## 4. Verification and Rollback Testing Summary
- **Zero Failed Requests:** Traffic script ran continuously from Step 0 through Step 7 without interruption, recording rolling restarts as `rerouted` and completing with `RESULT: zero failed requests`.
- **Consistency Checks:** `npm run check` was executed after every single step and verified consistency across columns, row counts, data types, and values (`CONSISTENT`).
- **Down-Migration Verification:** All down migrations (`003.down.sql`, `002.down.sql`, `001.down.sql`) were executed and verified in sequence on a test database to guarantee bidirectional reversibility up to the point of no return.

