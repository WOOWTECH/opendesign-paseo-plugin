#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createManager } from '../src/manager.mjs';
import { environmentContext } from '../src/runtime-context.mjs';

export async function runSupervision(manager, { signal, intervalMs = 2000, maxBackoffMs = 30000 } = {}) {
  let failures = 0;
  const abort = () => manager.cancelPending();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!signal?.aborted) {
      try {
        const result = await manager.reconcile();
        if (!result.desiredEnabled) break;
        failures = 0;
      } catch (error) {
        if (signal?.aborted) break;
        // Bounded retry delay; diagnostics are read through the manager, never logged.
        if (!['LOCK_BUSY', 'RUNTIME_BUSY'].includes(error.code)) failures++;
      }
      try { await delay(Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 4)), undefined, { signal }); }
      catch { if (signal?.aborted) break; }
    }
  } finally { signal?.removeEventListener('abort', abort); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const context = environmentContext();
    const manager = createManager({ dataDir: context.dataDir, home: context.home, packageRoot: context.packageRoot, env: context.env });
    await runSupervision(manager, { signal: controller.signal });
  } catch { process.exitCode = 1; }
}
