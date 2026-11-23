import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import { resolveServerPort, serverUrl } from '../server.config.ts';

const port = resolveServerPort();
const devUrl = serverUrl(port);
const cargoBin = process.env.HOME ? `${process.env.HOME}/.cargo/bin` : '';
const pathEnv = [cargoBin, process.env.PATH].filter(Boolean).join(delimiter);
const config = JSON.stringify({ build: { devUrl } });

const child = spawn('tauri', ['dev', '--config', config], {
  stdio: 'inherit',
  env: { ...process.env, PATH: pathEnv },
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`Failed to start Tauri: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
