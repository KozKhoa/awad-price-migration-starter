# SELF_ASSESSMENT_REPORT.md

**Student ID:** 23120285  
**Student Name:** Huỳnh Đăng Khoa  
**Course:** CSC13114 — Advanced Web Application Development  
**Assignment:** IA#2 — Zero-Downtime Migration  
**Total Claimed Score:** 100 / 100  

---

## Rubric Self-Assessment Table

| # | Criterion | Max Points | Claimed | Evidence & Verification |
|---|---|:---:|:---:|---|
| **1** | **The plan** | 20 | **20** | `MIGRATION.md` contains a complete step-by-step table where every row specifies: Schema After Step, Code Version per instance, Exact Undo Command, and Earlier Versions Safe Against Schema. Step 7 is explicitly designated as the **Point of No Return** with a detailed explanation of permanent data loss and fatal SQLite errors upon rollback. Tags (`v1`, `v2`, `v3`, `v4`) and migrations (`001`, `002`, `003`) in the repository match the plan exactly. |
| **2** | **Expand and dual write** | 20 | **20** | `002_add_price_vnd.up.sql` adds column `price_vnd INTEGER CHECK (price_vnd > 0);` without breaking `v1`. Version `v2` writes both `price` and `price_vnd` on all write paths (`POST /menu`, `PATCH /menu/:id`). The API offers `priceVnd` while continuously returning `price`. Every migration includes `.down.sql`, and `npm run migrate:down` was verified in sequence on a separate database (`data/down_test.db`), with complete output recorded in `check-log.txt`. |
| **3** | **Backfill** | 15 | **15** | `scripts/backfill.js` updates all 20,000 seeded items in batches of 500, each batch committed in its own short transaction (`BEGIN IMMEDIATE` / `COMMIT`) with delay pauses to avoid starving live traffic locks. Idempotent and resumable (`WHERE price_vnd IS NULL`). Executed only after `v2` was serving on all instances. `check-log.txt` displays `CONSISTENT` (0 nulls, 0 disagreement) immediately following the run. |
| **4** | **Zero failed requests** | 20 | **20** | `traffic-log.txt` contains **one continuous run** spanning every deploy and migration from `v1` to post-migration 003, concluding with `RESULT: zero failed requests` (`ok=269898 error=0 contract=0 stale=0 unavailable=0 rerouted=139`). Rolling restarts are visibly recorded with individual `down` and `back` lines per instance, properly categorized as `rerouted`. `NEW_CLIENTS=0.3` was enabled dynamically right after backfill completed (when all 20,000+ items had `price_vnd` populated) and sustained across all subsequent steps (`v3`, rollback drill, `v4`, schema contract). |
| **5** | **The way back** | 15 | **15** | Under live traffic, the version reading `price_vnd` (`v3`) was rolled back to `v2` on both instances, then rolled forward back to `v3`. Zero failures occurred in `traffic-log.txt` during the drill. `check-log.txt` records `CONSISTENT` before, during (Step 5a), and after (Step 5b). `MIGRATION.md` Section 3 details why this rollback was safe (both versions dual-write) and why rolling back after `v4` or schema drop would cause data inconsistency or crashes. |
| **6** | **Contract** | 10 | **10** | `menu_items.price` was dropped in migration 003 only after `v4` (which neither reads nor writes `price`) was serving on every instance. After the drop, old clients continue receiving `price` in all HTTP responses (computed on the fly), new clients receive `priceVnd`, order calculations remain consistent, and the traffic log remains 100% clean. |
| | **TOTAL** | **100** | **100** | |

---

## What I Did Not Manage
* None. All 6 rubric criteria were achieved to the highest specification (100/100 points).

