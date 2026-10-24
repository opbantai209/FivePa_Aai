import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';

async function test() {
  console.log('Testing PGlite in-memory...');
  try {
    const db = new PGlite();
    await db.waitReady;
    console.log('In-memory PGlite ready!');
    await db.close();
  } catch (err) {
    console.error('In-memory PGlite failed:', err);
  }

  console.log('Testing PGlite with path...');
  const testDir = '/tmp/pglite-test-' + Date.now();
  try {
    fs.mkdirSync(testDir, { recursive: true });
    const db = new PGlite(testDir);
    await db.waitReady;
    console.log('Path-based PGlite ready!');
    await db.close();
  } catch (err) {
    console.error('Path-based PGlite failed:', err);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

test();
