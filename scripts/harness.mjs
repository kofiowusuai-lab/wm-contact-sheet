#!/usr/bin/env node

import { existsSync } from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';

const root = process.cwd();
const preferredPort = Number(process.env.PORT || 3000);

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: options.stdio || 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...options.env },
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
    child.on('error', reject);
  });
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(start) {
  for (let port = start; port < start + 50; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free local port found from ${start} to ${start + 49}`);
}

async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* server not ready */
    }
    await delay(500);
  }
}

function openUrl(url) {
  if (process.env.WM_NO_OPEN === '1') {
    console.log(`[wm harness] browser launch skipped; open ${url}`);
    return;
  }

  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'start'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  const child = spawn(cmd, args, {
    shell: process.platform === 'win32',
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

async function main() {
  if (!existsSync('node_modules')) {
    console.log('[wm harness] node_modules missing; running npm install...');
    await run('npm', ['install']);
  }

  const port = await pickPort(preferredPort);
  const url = `http://127.0.0.1:${port}`;
  console.log(`[wm harness] starting local harness at ${url}`);
  console.log('[wm harness] storage: .wm-data');
  console.log('[wm harness] first run will ask for FAL, ElevenLabs, and Gemini keys.');

  const dev = spawn('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      WM_STORAGE: process.env.WM_STORAGE || 'local',
      WM_DATA_DIR: process.env.WM_DATA_DIR || '.wm-data',
      PORT: String(port),
    },
    shell: process.platform === 'win32',
  });

  dev.on('exit', (code) => process.exit(code ?? 0));
  dev.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });

  await waitFor(`${url}/api/local/status`);
  openUrl(url);
}

main().catch((err) => {
  console.error(`[wm harness] ${err.message}`);
  process.exit(1);
});
