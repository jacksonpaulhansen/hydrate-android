import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const host = '127.0.0.1';
const port = 8787;
const projectRoot = process.cwd();
const apiVersion = '2026-03-22-link-git-ui-1';

let publishRunning = false;
let publishStartedAt = 0;
let lastPublish = {
  ok: null,
  error: '',
  logs: '',
  at: '',
};

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

function readConfig() {
  const configPath = path.join(projectRoot, 'app.config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function writeConfig(config) {
  const configPath = path.join(projectRoot, 'app.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const git = spawn('git', args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    git.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    git.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    git.on('error', reject);
    git.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `git ${args.join(' ')} failed with code ${code}`));
      }
    });
  });
}

async function readGitConfigValue(scope, key) {
  try {
    const output = await runGit(['config', scope, key]);
    return String(output).trim();
  } catch {
    return '';
  }
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
        resolve(output);
      } else {
        reject(new Error(output || `publish-qr.ps1 exited with code ${code}`));
      }
    });
  });
}

function triggerReboot() {
  const scriptPath = path.join(projectRoot, 'reboot-app.ps1');
  const ps = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      cwd: projectRoot,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    },
  );
  ps.unref();
}

function triggerLinkGit() {
  const scriptPath = path.join(projectRoot, 'link-git.ps1');
  const child = spawn(
    'cmd',
    ['/c', 'start', '""', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', scriptPath],
    {
      cwd: projectRoot,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();
}

function openUrl(url) {
  const child = spawn('cmd', ['/c', 'start', '""', url], {
    cwd: projectRoot,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
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
    sendJson(res, 200, {
      ok: true,
      service: 'control-server',
      version: apiVersion,
      capabilities: ['publish', 'reboot', 'link-git'],
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    try {
      const config = readConfig();
      sendJson(res, 200, {
        ok: true,
        config: {
          appName: config.appName ?? '',
          publishUrl: config.publishUrl ?? '',
          git: config.git ?? {},
        },
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/last-publish') {
    sendJson(res, 200, { ok: true, lastPublish });
    return;
  }

  if (req.method === 'POST' && req.url === '/publish') {
    if (publishRunning && Date.now() - publishStartedAt > 130000) {
      publishRunning = false;
      publishStartedAt = 0;
    }

    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Publish already running' });
      return;
    }

    publishRunning = true;
    publishStartedAt = Date.now();
    try {
      const logs = await runPublish();
      lastPublish = {
        ok: true,
        error: '',
        logs,
        at: new Date().toISOString(),
      };
      sendJson(res, 200, { ok: true, logs });
    } catch (error) {
      const errText = String(error);
      lastPublish = {
        ok: false,
        error: errText,
        logs: errText,
        at: new Date().toISOString(),
      };
      sendJson(res, 500, { ok: false, error: errText, logs: errText });
    } finally {
      publishRunning = false;
      publishStartedAt = 0;
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/reboot') {
    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Cannot reboot while publish is running' });
      return;
    }

    sendJson(res, 200, { ok: true, message: 'Reboot started' });
    setTimeout(() => {
      try {
        triggerReboot();
      } catch {}
    }, 250);
    return;
  }

  if (req.method === 'POST' && req.url === '/link-git') {
    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Cannot link git while publish is running' });
      return;
    }

    try {
      triggerLinkGit();
      sendJson(res, 200, { ok: true, message: 'Git/Repo setup wizard opened in a new terminal window.' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/open-github') {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const mode = payload.mode === 'new' ? 'new' : 'login';
        const url = mode === 'new' ? 'https://github.com/new' : 'https://github.com/login';
        openUrl(url);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/config/git') {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        let userName = String(payload.userName ?? '').trim();
        let userEmail = String(payload.userEmail ?? '').trim();
        const githubUser = String(payload.githubUser ?? '').trim();
        const repoName = String(payload.repoName ?? '').trim();
        const branch = String(payload.branch ?? 'main').trim() || 'main';

        if (!githubUser || !repoName) {
          sendJson(res, 400, { ok: false, error: 'githubUser and repoName are required' });
          return;
        }

        const config = readConfig();
        const gitCfg = config.git || {};

        if (userName === 'Your Name') {
          userName = '';
        }
        if (userEmail === 'you@example.com') {
          userEmail = '';
        }

        if (!userName) {
          userName = String(gitCfg.userName ?? '').trim();
        }
        if (!userEmail) {
          userEmail = String(gitCfg.userEmail ?? '').trim();
        }
        if (userName === 'Your Name') {
          userName = '';
        }
        if (userEmail === 'you@example.com') {
          userEmail = '';
        }
        if (!userName) {
          userName = await readGitConfigValue('--global', 'user.name');
        }
        if (!userEmail) {
          userEmail = await readGitConfigValue('--global', 'user.email');
        }
        if (!userName) {
          userName = githubUser;
        }
        if (!userEmail) {
          userEmail = `${githubUser}@users.noreply.github.com`;
        }

        const remoteUrl = `https://github.com/${githubUser}/${repoName}.git`;
        const publishUrl = `https://${githubUser}.github.io/${repoName}/`;

        config.publishUrl = publishUrl;
        config.git = config.git || {};
        config.git.enabled = true;
        config.git.userName = userName;
        config.git.userEmail = userEmail;
        config.git.remoteUrl = remoteUrl;
        config.git.branch = branch;
        config.git.commitMessagePrefix = config.git.commitMessagePrefix || 'publish';
        config.git.autoSetGithubPagesUrl = true;
        config.git.users = Array.isArray(config.git.users) ? config.git.users : [];
        config.git.repos = Array.isArray(config.git.repos) ? config.git.repos : [];

        if (!config.git.users.some((u) => u?.name === userName && u?.email === userEmail)) {
          config.git.users.push({ name: userName, email: userEmail });
        }
        if (!config.git.repos.includes(remoteUrl)) {
          config.git.repos.push(remoteUrl);
        }

        writeConfig(config);

        if (!fs.existsSync(path.join(projectRoot, '.git'))) {
          await runGit(['init', '-b', branch]);
        }
        await runGit(['config', 'user.name', userName]);
        await runGit(['config', 'user.email', userEmail]);
        await runGit(['config', 'credential.helper', 'manager']);

        try {
          await runGit(['remote', 'add', 'origin', remoteUrl]);
        } catch {
          await runGit(['remote', 'set-url', 'origin', remoteUrl]);
        }

        sendJson(res, 200, { ok: true, remoteUrl, publishUrl });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(port, host, () => {
  console.log(`[control] listening on http://${host}:${port}`);
});
