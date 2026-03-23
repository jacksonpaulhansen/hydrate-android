import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const host = '127.0.0.1';
const port = 8787;
const projectRoot = process.cwd();
const apiVersion = '2026-03-22-publish-app-1';

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

function readLocalSecrets() {
  const secretsPath = path.join(projectRoot, '.app.secrets.local.json');
  if (!fs.existsSync(secretsPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeLocalSecrets(secrets) {
  const secretsPath = path.join(projectRoot, '.app.secrets.local.json');
  fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8');
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

function runGitWithPat(args, owner, repo, token) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GITHUB_TOKEN: token };
    const askpassPath = path.join(projectRoot, 'scripts', 'git-askpass.cmd');
    env.GIT_ASKPASS = askpassPath;

    const git = spawn('git', args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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

async function githubApi({ token, method, pathName, body }) {
  const response = await fetch(`https://api.github.com${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

function sanitizeRepoName(name) {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return clean || 'even-g2-app';
}

function runPublishLegacy() {
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

function triggerSwitchGitAccount() {
  const scriptPath = path.join(projectRoot, 'switch-git-account.ps1');
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

async function waitForPublishedUrl(url, timeoutMs = 90000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probeUrl = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      const response = await fetch(probeUrl, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
      });
      if (response.ok) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function generateQrForUrl(publishUrl) {
  await new Promise((resolve, reject) => {
    const node = spawn('node', ['scripts/generate-qr.mjs', publishUrl], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    node.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    node.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    node.on('error', reject);
    node.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `QR generation failed with code ${code}`));
      }
    });
  });

  const htmlPath = path.join(projectRoot, 'publish-qr.html');
  if (fs.existsSync(htmlPath)) {
    openUrl(htmlPath);
  }
}

async function runPublishApp(appName, patInput) {
  const logs = [];
  const config = readConfig();
  const secrets = readLocalSecrets();

  config.github = config.github || {};
  const token = (patInput || secrets.githubPat || '').trim();
  if (!token) {
    const err = new Error('PAT_REQUIRED');
    err.code = 'PAT_REQUIRED';
    throw err;
  }

  const userResult = await githubApi({ token, method: 'GET', pathName: '/user' });
  if (!userResult.response.ok) {
    const err = new Error('Invalid GitHub PAT. Please provide a valid token with repo/workflow/pages permissions.');
    err.code = 'INVALID_PAT';
    throw err;
  }

  const owner = String(userResult.json?.login || '').trim();
  if (!owner) {
    throw new Error('Failed to resolve GitHub user from PAT.');
  }

  const repo = sanitizeRepoName(appName);
  const remoteUrl = `https://github.com/${owner}/${repo}.git`;
  const publishUrl = `https://${owner}.github.io/${repo}/`;

  // Create repo if needed.
  const createRepoResult = await githubApi({
    token,
    method: 'POST',
    pathName: '/user/repos',
    body: {
      name: repo,
      private: false,
      auto_init: false,
    },
  });

  if (createRepoResult.response.status === 201) {
    logs.push(`Created repo: ${owner}/${repo}`);
  } else if (createRepoResult.response.status === 422) {
    logs.push(`Repo already exists: ${owner}/${repo}`);
  } else if (!createRepoResult.response.ok) {
    throw new Error(`GitHub repo create failed: ${createRepoResult.text || createRepoResult.response.status}`);
  }

  const branch = 'main';
  const userName = owner;
  const ghId = String(userResult.json?.id ?? '').trim();
  const userEmail = ghId
    ? `${ghId}+${owner}@users.noreply.github.com`
    : `${owner}@users.noreply.github.com`;

  config.appName = appName;
  config.publishUrl = publishUrl;
  config.github.owner = owner;
  config.github.repo = repo;
  config.github.pat = '';
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
  config.git.deployed = false;

  if (!config.git.users.some((u) => u?.name === userName && u?.email === userEmail)) {
    config.git.users.push({ name: userName, email: userEmail });
  }
  if (!config.git.repos.includes(remoteUrl)) {
    config.git.repos.push(remoteUrl);
  }

  writeConfig(config);
  if (patInput && patInput.trim()) {
    secrets.githubPat = token;
    writeLocalSecrets(secrets);
  }

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

  await runGit(['add', '-A']);
  const diffOutput = await runGit(['diff', '--cached', '--name-only']);
  const hasChanges = diffOutput.trim().length > 0;
  if (hasChanges) {
    await runGit([
      '-c',
      `user.name=${userName}`,
      '-c',
      `user.email=${userEmail}`,
      'commit',
      '-m',
      `publish ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    ]);
    logs.push('Committed local changes');
  } else {
    logs.push('No new file changes to commit');
  }

  await runGitWithPat(['push', '-u', remoteUrl, `HEAD:${branch}`], owner, repo, token);
  logs.push(`Pushed to origin/${branch}`);

  // Enable Pages with workflow build type.
  const pagesPut = await githubApi({
    token,
    method: 'PUT',
    pathName: `/repos/${owner}/${repo}/pages`,
    body: { build_type: 'workflow' },
  });

  if (!pagesPut.response.ok) {
    const pagesPost = await githubApi({
      token,
      method: 'POST',
      pathName: `/repos/${owner}/${repo}/pages`,
      body: { build_type: 'workflow' },
    });
    if (!pagesPost.response.ok && pagesPost.response.status !== 409) {
      logs.push(`Pages enable warning: ${pagesPost.text || pagesPost.response.status}`);
    } else {
      logs.push('GitHub Pages enabled');
    }
  } else {
    logs.push('GitHub Pages enabled');
  }

  // Trigger deploy workflow
  const workflowDispatch = await githubApi({
    token,
    method: 'POST',
    pathName: `/repos/${owner}/${repo}/actions/workflows/deploy-pages.yml/dispatches`,
    body: { ref: branch },
  });

  if (workflowDispatch.response.status === 204) {
    logs.push('Triggered Deploy GitHub Pages workflow');
  } else {
    logs.push(`Workflow dispatch warning: ${workflowDispatch.text || workflowDispatch.response.status}`);
  }

  const finalConfig = readConfig();
  finalConfig.git = finalConfig.git || {};
  finalConfig.git.deployed = true;
  writeConfig(finalConfig);

  await generateQrForUrl(publishUrl);
  logs.push('Waiting for published site to become available...');
  const siteReady = await waitForPublishedUrl(publishUrl, 90000, 3000);
  if (siteReady) {
    logs.push('Published site is live.');
  } else {
    logs.push('Publish URL still propagating; opening anyway.');
  }
  openUrl(publishUrl);

  return {
    logs: logs.join('\n'),
    publishUrl,
    remoteUrl,
    owner,
    repo,
  };
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
      capabilities: ['publish', 'publish-app', 'reboot', 'link-git', 'switch-git-account'],
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    try {
      const config = readConfig();
      const secrets = readLocalSecrets();
      sendJson(res, 200, {
        ok: true,
        config: {
          appName: config.appName ?? '',
          publishUrl: config.publishUrl ?? '',
          github: {
            owner: config.github?.owner ?? '',
            repo: config.github?.repo ?? '',
            hasPat: !!String(secrets.githubPat ?? '').trim(),
          },
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
      const logs = await runPublishLegacy();
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

  if (req.method === 'POST' && req.url === '/publish-app') {
    if (publishRunning && Date.now() - publishStartedAt > 300000) {
      publishRunning = false;
      publishStartedAt = 0;
    }

    if (publishRunning) {
      sendJson(res, 409, { ok: false, error: 'Publish already running' });
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', async () => {
      publishRunning = true;
      publishStartedAt = Date.now();
      try {
        const payload = body ? JSON.parse(body) : {};
        const appNameRaw = String(payload.appName ?? '').trim();
        const appName = appNameRaw || 'even-g2-app';
        const pat = String(payload.pat ?? '').trim();

        const result = await runPublishApp(appName, pat);
        lastPublish = {
          ok: true,
          error: '',
          logs: result.logs,
          at: new Date().toISOString(),
        };
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        const errCode = String(error?.code ?? '').trim();
        const errText = String(error);
        const errMsg = String(error?.message ?? '');
        const isPatRequired = errCode === 'PAT_REQUIRED' || errText.includes('PAT_REQUIRED');
        const isInvalidPat =
          errCode === 'INVALID_PAT' ||
          errText.includes('INVALID_PAT') ||
          errMsg.toLowerCase().includes('invalid github pat');
        lastPublish = {
          ok: false,
          error: errText,
          logs: errText,
          at: new Date().toISOString(),
        };
        sendJson(res, isPatRequired || isInvalidPat ? 400 : 500, {
          ok: false,
          error: isPatRequired ? 'PAT_REQUIRED' : isInvalidPat ? 'INVALID_PAT' : errText,
          code: isPatRequired ? 'PAT_REQUIRED' : isInvalidPat ? 'INVALID_PAT' : undefined,
        });
      } finally {
        publishRunning = false;
        publishStartedAt = 0;
      }
    });
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

  if (req.method === 'POST' && req.url === '/switch-git-account') {
    try {
      triggerSwitchGitAccount();
      sendJson(res, 200, { ok: true, message: 'Opened Git account switch flow.' });
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
        let githubUser = String(payload.githubUser ?? '').trim();
        let repoName = String(payload.repoName ?? '').trim();
        const branch = String(payload.branch ?? 'main').trim() || 'main';

        if (repoName.endsWith('.git')) {
          repoName = repoName.slice(0, -4);
        }
        if (repoName.includes('/')) {
          const parts = repoName.split('/').filter(Boolean);
          if (parts.length >= 2) {
            githubUser = parts[0];
            repoName = parts[1];
          }
        }

        if (!githubUser || !repoName) {
          sendJson(res, 400, { ok: false, error: 'githubUser and repoName are required' });
          return;
        }

        const config = readConfig();
        const gitCfg = config.git || {};

        if (userName === 'Your Name') userName = '';
        if (userEmail === 'you@example.com') userEmail = '';

        if (!userName) userName = String(gitCfg.userName ?? '').trim();
        if (!userEmail) userEmail = String(gitCfg.userEmail ?? '').trim();
        if (userName === 'Your Name') userName = '';
        if (userEmail === 'you@example.com') userEmail = '';
        if (!userName) userName = githubUser;
        if (!userEmail) userEmail = `${githubUser}@users.noreply.github.com`;

        const remoteUrl = `https://github.com/${githubUser}/${repoName}.git`;
        const publishUrl = `https://${githubUser}.github.io/${repoName}/`;

        config.publishUrl = publishUrl;
        config.github = config.github || {};
        config.github.owner = githubUser;
        config.github.repo = repoName;
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
