# AI-LOG.md — AI Assistant Usage Log

**Course:** CSC13114 — Advanced Web Application Development  
**Assignment:** IA#2 — Zero-Downtime Migration  
**Assistant:** Google DeepMind Antigravity AI Assistant (Gemini 3.8 Flash High)

---

## 1. Overview and Level of Engagement

In accordance with course guidelines and Session 3/4 instructions, this document records the prompts, assistance, and verification steps involved in completing this zero-downtime migration assignment.

* **Assistance Tier:** Tier 2 / 3 (The AI assistant drafted architectural designs, code refactoring slices for `v2`, `v3`, and `v4`, migration SQL scripts, backfill batching logic, and the orchestration plan; the student verified, tested, executed the migrations, and reviewed all traffic and consistency logs).

---

## 2. Log of Interactions

### Interaction 1: Rubric Analysis and Migration Strategy
* **Prompt / Task:** Analyze the assignment rubric for IA#2 (Zero-downtime migration), review the starter repository, and devise a step-by-step Expand/Contract plan meeting all 6 criteria for 100 points.
* **AI Output:**
  - Decomposed the requirements into a 7-step zero-downtime lifecycle (`v1` baseline -> schema expand -> `v2` dual-write -> batch backfill -> `v3` read-new -> rollback drill -> `v4` write-only-new -> schema contract drop `price`).
  - Identified the exact Point of No Return (`003_drop_price.up.sql`) and explained why previous versions would crash if executed after the drop.
  - Outlined the bidirectional rollback safety between `v3` and `v2`.
* **Human Verification:** Verified that `v1` represents the unmodified starter code, and verified that `v2` through `v4` adhere to the HTTP backward-compatibility contract (returning both `price` and `priceVnd`).

### Interaction 2: Migration Scripts and Reversibility
* **Prompt / Task:** Create migration pairs (`002_add_price_vnd.up.sql` / `.down.sql` and `003_drop_price.up.sql` / `.down.sql`). Ensure down-migrations work correctly in SQLite.
* **AI Output:**
  - Wrote SQL DDL using `ALTER TABLE menu_items ADD COLUMN price_vnd INTEGER CHECK (price_vnd > 0);` and `ALTER TABLE menu_items DROP COLUMN price;`.
  - Added respective `.down.sql` files.
* **Human Verification:** Executed tests on a separate database (`data/down_test.db`) demonstrating that `npm run migrate:down` safely reverts each migration in reverse order.

### Interaction 3: Dual Write, Read Switch, and Decoupling
* **Prompt / Task:** Implement code versions for the server:
  - `v2`: Dual-write to both columns, read `price`, support both `price` and `priceVnd` in the API.
  - `v3`: Read `price_vnd`, maintain dual-write.
  - `v4`: Write and read only `price_vnd`, preserve old client response shapes without touching column `price`.
* **AI Output:** Produced `src/app.js` and test updates for tags `v2`, `v3`, and `v4`.
* **Human Verification:** Ran `npm test` across all versions; all unit tests passed with 0 failures.

### Interaction 4: Idempotent Batch Backfill
* **Prompt / Task:** Write `scripts/backfill.js` that updates 20,000 items in batches within short transactions so it can run concurrently while traffic is live.
* **AI Output:** Implemented batch querying with `LIMIT 500`, transactions scoped per batch (`BEGIN IMMEDIATE` / `COMMIT`), and progress reporting.
* **Human Verification:** Checked concurrency behavior with SQLite WAL mode and verified with `npm run check` immediately after execution (`CONSISTENT`, 0 nulls, 0 disagreements).

### Interaction 5: Continuous Traffic and Rollback Verification
* **Prompt / Task:** Run a single continuous instance of `npm run traffic` across the entire sequence. Enable `NEW_CLIENTS=0.3` after `v2` deployment without stopping traffic. Conduct the live rollback drill (`v3` -> `v2` -> `v3`).
* **AI Output:** Updated `scripts/traffic.js` with dynamic ratio detection and authored `scripts/orchestrate-migration.js` to coordinate rolling restarts with SIGTERM/graceful shutdown.
* **Human Verification:** Observed real-time down / back transitions for one instance at a time (`rerouted`), zero failed requests (`RESULT: zero failed requests`), and verified consistency logs before and after rollback.

---

## 3. Reflection and Learnings

- **Expand-Contract Pattern:** Decoupling database changes from application code deployments is essential to avoid service interruptions. A common pitfall is dropping or changing a column before all serving application instances have stopped reading/writing to it.
- **SQLite Concurrency & WAL:** Small, frequent transactions during backfills prevent locking the database for extended periods, enabling the traffic generator to continue read and write traffic concurrently.
- **Rollback Safety Window:** Rollbacks are only safe while both columns remain populated and synchronized via dual-writing. Once the old column is removed or a version writes only to the new column, the point of no return is crossed.

