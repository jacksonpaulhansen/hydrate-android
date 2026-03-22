import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';

const host = '127.0.0.1';
const port = 8787;
const projectRoot = process.cwd();

let publishRunning = false;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function runPublish() {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectRoot, 'publish-qr.ps1');
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-NonInteractive'],
      {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    ps.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    ps.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    const timer = setTimeout(() => {
      ps.kill('SIGTERM');
      reject(new Error('Publish timed out after 120s'));
    }, 120000);

    ps.on('error', reject);
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(output || `publish-qr.ps1 exited with code ${code}`));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, service: 'control-server' });
    return;
  }

  if (req.method === 'POST' && req.url === '/publish') {
    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Publish already running' });
      return;
    }

    publishRunning = true;
    try {
      await runPublish();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    } finally {
      publishRunning = false;
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(port, host, () => {
  console.log(`[control] listening on http://${host}:${port}`);
});
