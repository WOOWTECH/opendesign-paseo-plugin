import { spawn } from 'node:child_process';
import path from 'node:path';
import { RuntimeError } from '../vendor/pi-paseo/src/state.mjs';
import { safeError } from './runtime-context.mjs';
import { providerEnvironment } from './provider-install.mjs';

export const budgets = Object.freeze({ status: 15000, diagnose: 175000, models: 175000, pair: 25000, enable: 1300000, disable: 45000, acceptance: 1300000, createchat: 660000, continue: 660000 });

export function callRuntime(context, action, input = {}, { signal, timeoutMs = budgets[action] || 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(context.packageRoot, 'src/runtime-worker.mjs')], { cwd: context.home, env: providerEnvironment(context), detached: process.platform === 'linux', shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0, stdout = '', failure, killTimer;
    const stop = category => {
      failure ||= new RuntimeError(category);
      const kill = signal => { try { if (process.platform === 'linux' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
      kill('SIGTERM');
      killTimer ||= setTimeout(() => kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop('OPERATION_TIMEOUT'), timeoutMs);
    const abort = () => stop('OPERATION_ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('COMMAND_OUTPUT_LIMIT'); else stdout += chunk; });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('COMMAND_OUTPUT_LIMIT'); });
    child.stdin.on('error', () => {});
    child.once('error', () => { failure ||= new RuntimeError('COMMAND_UNAVAILABLE'); });
    child.once('close', () => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      try {
        const value = JSON.parse(stdout);
        if (value.ok !== true) throw safeError(value);
        resolve(value.result);
      } catch (error) { reject(error instanceof RuntimeError ? error : new RuntimeError('INVALID_COMMAND_OUTPUT')); }
    });
    child.stdin.end(JSON.stringify({ action, input }));
  });
}
