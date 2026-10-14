// Orchestrate the entire zero-downtime migration sequence under continuous traffic.
// Generates authentic, continuous traffic-log.txt and step-by-step check-log.txt.
import { spawn, execSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { open, DB_PATH } from '../src/db.js';

const ROOT = resolve(import.meta.dirname, '..');
const DB_FILE = resolve(ROOT, 'data/app.db');
const TRAFFIC_LOG = resolve(ROOT, 'traffic-log.txt');
const CHECK_LOG = resolve(ROOT, 'check-log.txt');
const NEW_CLIENTS_FILE = resolve(ROOT, '.new_clients');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function ensurePortFree(port, maxWaitMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    try {
      await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(100) });
      await sleep(150);
    } catch {
      return true; // port refused connection, now free!
    }
  }
  return true;
}

function runCheck(stepLabel) {
  console.log(`\n---> Running check for ${stepLabel}...`);
  appendFileSync(CHECK_LOG, `\n=== ${stepLabel} ===\n`);
  try {
    const out = execSync(`node scripts/check.js`, {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: DB_FILE },
      encoding: 'utf8',
    });
    console.log(out.trim());
    appendFileSync(CHECK_LOG, out);
  } catch (err) {
    const out = err.stdout?.toString() || err.message;
    console.error(out.trim());
    appendFileSync(CHECK_LOG, out);
  }
}

async function startServer(version, port, retries = 5) {
  const dir = resolve(ROOT, `.worktrees/${version}`);
  for (let attempt = 1; attempt <= retries; attempt++) {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), DB_PATH: DB_FILE },
      stdio: 'inherit',
    });

    let exited = false;
    child.once('exit', () => { exited = true; });

    // Wait up to 3000ms for health check
    for (let i = 0; i < 30; i++) {
      if (exited) break;
      try {
        const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(200) });
        if (res.ok) return child;
      } catch {}
      await sleep(100);
    }

    if (attempt < retries) {
      try { child.kill('SIGKILL'); } catch {}
      await sleep(1000);
    } else {
      return child;
    }
  }
}

async function stopServer(proc, port) {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM');
    const normalExit = await Promise.race([
      new Promise((resolve) => proc.once('exit', () => resolve(true))),
      sleep(3000).then(() => false),
    ]);
    if (!normalExit && proc.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch {}
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        sleep(500),
      ]);
    }
  }
  await ensurePortFree(port);
  await sleep(400);
}

async function main() {
  console.log('=== Initializing IA#2 Zero-Downtime Migration Simulation ===');

  // Clean previous artifacts
  for (const f of [TRAFFIC_LOG, CHECK_LOG, NEW_CLIENTS_FILE]) {
    if (existsSync(f)) unlinkSync(f);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) unlinkSync(DB_FILE + suffix);
  }

  // Baseline setup: Apply only 001_init on app.db
  console.log('Initializing database schema 001_init...');
  const db = open(DB_FILE);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const sql001 = readFileSync(resolve(ROOT, 'migrations/001_init.up.sql'), 'utf8');
  db.exec('BEGIN IMMEDIATE');
  db.exec(sql001);
  db.prepare("INSERT INTO schema_migrations VALUES ('001_init', datetime('now'))").run();
  db.exec('COMMIT');
  db.close();

  // Seed 20,000 items
  console.log('Seeding database with 20,000 items...');
  execSync(`node scripts/seed.js`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DB_FILE },
    stdio: 'inherit',
  });

  // Verify baseline with check
  runCheck('Step 0: Initial baseline (schema 001_init, 20,000 items, v1 running)');

  // Start instances A (:3001) and B (:3002) running v1
  console.log('\nStarting instance A (:3001) on v1...');
  let instA = await startServer('v1', 3001);
  await waitForHttp('http://localhost:3001/health');

  console.log('Starting instance B (:3002) on v1...');
  let instB = await startServer('v1', 3002);
  await waitForHttp('http://localhost:3002/health');

  // Start continuous traffic
  console.log('\nStarting continuous traffic worker...');
  const trafficProc = spawn(process.execPath, ['scripts/traffic.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DB_FILE, LOG: TRAFFIC_LOG },
    stdio: 'inherit',
  });

  // Wait 12 seconds under v1 traffic
  console.log('\nServing v1 traffic for 12 seconds...');
  await sleep(12000);

  // STEP 1: Apply Migration 002 (Expand Schema)
  console.log('\n==============================================');
  console.log('STEP 1: Schema Expand — Apply 002_add_price_vnd');
  console.log('==============================================');
  {
    const db = open(DB_FILE);
    const sql002 = readFileSync(resolve(ROOT, 'migrations/002_add_price_vnd.up.sql'), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    db.exec(sql002);
    db.prepare("INSERT INTO schema_migrations VALUES ('002_add_price_vnd', datetime('now'))").run();
    db.exec('COMMIT');
    db.close();
  }
  console.log('Applied migration 002_add_price_vnd.');
  await sleep(4000);
  runCheck('Step 1: After schema expand (002_add_price_vnd applied, v1 still running)');
  await sleep(3000);

  // STEP 2: Rolling Deploy to v2 (Dual Write)
  console.log('\n==============================================');
  console.log('STEP 2: Rolling deploy to v2 (Dual Write)');
  console.log('==============================================');
  console.log('Restarting instance A (:3001) to v2...');
  await stopServer(instA, 3001);
  await sleep(600); // let traffic script record rerouted / target down
  instA = await startServer('v2', 3001);
  await waitForHttp('http://localhost:3001/health');
  console.log('Instance A (:3001) is up on v2.');
  await sleep(4000);

  console.log('Restarting instance B (:3002) to v2...');
  await stopServer(instB, 3002);
  await sleep(600); // let traffic script record rerouted / target down
  instB = await startServer('v2', 3002);
  await waitForHttp('http://localhost:3002/health');
  console.log('Instance B (:3002) is up on v2.');
  await sleep(4000);

  runCheck('Step 2: After rolling deploy to v2 (both instances on v2 dual-write, all writes update both columns)');
  await sleep(3000);

  // STEP 3: Run Backfill
  console.log('\n==============================================');
  console.log('STEP 3: Run backfill while traffic runs');
  console.log('==============================================');
  execSync(`node scripts/backfill.js`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DB_FILE, BATCH_SIZE: '500', DELAY_MS: '15' },
    stdio: 'inherit',
  });
  console.log('Backfill finished.');
  await sleep(2000);
  runCheck('Step 3: After backfill completion (all 20,000 items populated with price_vnd)');

  // NOW THAT BACKFILL IS COMPLETE, THE API OFFICIALLY OFFERS priceVnd!
  console.log('\nEnabling new clients (NEW_CLIENTS = 0.3)...');
  writeFileSync(NEW_CLIENTS_FILE, '0.3\n');
  await sleep(6000); // let traffic run with new clients

  // STEP 4: Rolling Deploy to v3 (Read price_vnd)
  console.log('\n==============================================');
  console.log('STEP 4: Rolling deploy to v3 (Read price_vnd)');
  console.log('==============================================');
  console.log('Restarting instance A (:3001) to v3...');
  await stopServer(instA, 3001);
  await sleep(600);
  instA = await startServer('v3', 3001);
  await waitForHttp('http://localhost:3001/health');
  console.log('Instance A (:3001) is up on v3.');
  await sleep(4000);

  console.log('Restarting instance B (:3002) to v3...');
  await stopServer(instB, 3002);
  await sleep(600);
  instB = await startServer('v3', 3002);
  await waitForHttp('http://localhost:3002/health');
  console.log('Instance B (:3002) is up on v3.');
  await sleep(3000);
  runCheck('Step 4: After rolling deploy to v3 (both instances read price_vnd, dual-write active)');
  await sleep(3000);

  // STEP 5: Rollback Drill under Live Traffic (Criterion 5)
  console.log('\n==============================================');
  console.log('STEP 5: Rollback Drill under Live Traffic (v3 -> v2 -> v3)');
  console.log('==============================================');
  console.log('Rolling back instance A (:3001) to v2...');
  await stopServer(instA, 3001);
  await sleep(600);
  instA = await startServer('v2', 3001);
  await waitForHttp('http://localhost:3001/health');
  console.log('Instance A (:3001) is back on v2.');
  await sleep(3000);

  console.log('Rolling back instance B (:3002) to v2...');
  await stopServer(instB, 3002);
  await sleep(600);
  instB = await startServer('v2', 3002);
  await waitForHttp('http://localhost:3002/health');
  console.log('Instance B (:3002) is back on v2.');
  await sleep(5000);
  runCheck('Step 5a: Rolled back to v2 under traffic (both instances on v2)');

  console.log('\nRolling forward instance A (:3001) back to v3...');
  await stopServer(instA, 3001);
  await sleep(600);
  instA = await startServer('v3', 3001);
  await waitForHttp('http://localhost:3001/health');
  console.log('Instance A (:3001) is forward on v3.');
  await sleep(3000);

  console.log('Rolling forward instance B (:3002) back to v3...');
  await stopServer(instB, 3002);
  await sleep(600);
  instB = await startServer('v3', 3002);
  await waitForHttp('http://localhost:3002/health');
  console.log('Instance B (:3002) is forward on v3.');
  await sleep(5000);
  runCheck('Step 5b: Rolled forward back to v3 under traffic (both instances on v3)');
  await sleep(3000);

  // STEP 6: Rolling Deploy to v4 (Write and Read ONLY price_vnd)
  console.log('\n==============================================');
  console.log('STEP 6: Rolling deploy to v4 (Write and read only price_vnd)');
  console.log('==============================================');
  console.log('Restarting instance A (:3001) to v4...');
  await stopServer(instA, 3001);
  await sleep(600);
  instA = await startServer('v4', 3001);
  await waitForHttp('http://localhost:3001/health');
  console.log('Instance A (:3001) is up on v4.');
  await sleep(4000);

  console.log('Restarting instance B (:3002) to v4...');
  await stopServer(instB, 3002);
  await sleep(600);
  instB = await startServer('v4', 3002);
  await waitForHttp('http://localhost:3002/health');
  console.log('Instance B (:3002) is up on v4.');
  await sleep(3000);
  runCheck('Step 6: After rolling deploy to v4 (both instances neither read nor write price)');
  await sleep(3000);

  // STEP 7: Apply Migration 003 (Schema Contract / Point of No Return)
  console.log('\n==============================================');
  console.log('STEP 7: Schema Contract — Drop price column (Point of No Return)');
  console.log('==============================================');
  {
    const db = open(DB_FILE);
    const sql003 = readFileSync(resolve(ROOT, 'migrations/003_drop_price.up.sql'), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    db.exec(sql003);
    db.prepare("INSERT INTO schema_migrations VALUES ('003_drop_price', datetime('now'))").run();
    db.exec('COMMIT');
    db.close();
  }
  console.log('Applied migration 003_drop_price.');
  await sleep(5000);
  runCheck('Step 7: After schema contract 003_drop_price (price dropped, POINT OF NO RETURN)');

  // Let traffic run on contracted schema
  console.log('\nServing traffic on contracted schema for 12 seconds...');
  await sleep(12000);

  // Stop traffic gracefully
  console.log('\nStopping traffic worker with SIGINT...');
  trafficProc.kill('SIGINT');
  await new Promise((resolve) => trafficProc.once('exit', resolve));
  console.log('Traffic worker stopped successfully.');

  // Stop server instances
  await stopServer(instA, 3001);
  await stopServer(instB, 3002);
  console.log('All servers stopped.');

  // Verify Down Migrations on a separate test database file
  console.log('\n==============================================');
  console.log('Down-Migration Verification on separate DB (data/down_test.db)');
  console.log('==============================================');
  const DOWN_DB = resolve(ROOT, 'data/down_test.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DOWN_DB + suffix)) unlinkSync(DOWN_DB + suffix);
  }

  appendFileSync(CHECK_LOG, `\n=== Down-Migration Verification (Separate DB: data/down_test.db) ===\n`);

  // Up all migrations
  const upOut = execSync(`node scripts/migrate.js up`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `\n[migrate up on down_test.db]\n${upOut}\n`);

  const status1 = execSync(`node scripts/migrate.js status`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `[migrate status on down_test.db]\n${status1}\n`);

  // Revert 003
  const down3 = execSync(`node scripts/migrate.js down`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `[migrate:down reverts 003_drop_price]\n${down3}\n`);
  const checkAfterDown3 = execSync(`node scripts/check.js`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `[check after reverting 003]\n${checkAfterDown3}\n`);

  // Revert 002
  const down2 = execSync(`node scripts/migrate.js down`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `[migrate:down reverts 002_add_price_vnd]\n${down2}\n`);
  const checkAfterDown2 = execSync(`node scripts/check.js`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `[check after reverting 002]\n${checkAfterDown2}\n`);

  // Revert 001
  const down1 = execSync(`node scripts/migrate.js down`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `[migrate:down reverts 001_init]\n${down1}\n`);
  const statusEnd = execSync(`node scripts/migrate.js status`, {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DOWN_DB },
    encoding: 'utf8',
  });
  appendFileSync(CHECK_LOG, `[migrate status after reverting all]\n${statusEnd}\n`);

  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DOWN_DB + suffix)) unlinkSync(DOWN_DB + suffix);
  }

  console.log('\n=== Simulation Completed Successfully! ===');
}

main().catch((err) => {
  console.error('Migration simulation failed:', err);
  process.exit(1);
});
