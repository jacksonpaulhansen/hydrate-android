import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const host = '127.0.0.1';
const port = 8787;
const projectRoot = process.cwd();
const apiVersion = '2026-04-09-publish-app-2';

let publishRunning = false;
let publishStartedAt = 0;
let ehpkRunning = false;
let apkBuildRunning = false;
let apkBuildStatus = {
  state: 'IDLE',
  logs: [],
  startedAt: '',
  finishedAt: '',
  error: '',
  result: null,
};
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
  let response;
  try {
    response = await fetch(`https://api.github.com${pathName}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error(`Network error reaching GitHub API (${pathName}): ${String(error)}. Check internet/VPN/firewall and retry.`);
  }

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

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveJavaHome() {
  const envJavaHome = String(process.env.JAVA_HOME || '').trim();
  if (envJavaHome && fs.existsSync(path.join(envJavaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    return envJavaHome;
  }

  const candidates = [
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    'C:\\Program Files\\Android\\Android Studio\\jre',
  ];
  for (const candidate of candidates) {
    const javaBin = path.join(candidate, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(javaBin)) {
      return candidate;
    }
  }
  return '';
}

async function buildAndStageAndroidApk(logs) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const androidDir = path.join(projectRoot, 'android');
  const publicDir = path.join(projectRoot, 'public');
  const outputFileName = 'hydrate-latest.apk';
  const stagedApkPath = path.join(publicDir, outputFileName);
  const javaHome = resolveJavaHome();

  logs.push('Building Android web assets + Capacitor sync...');
  await runCommand(npmCmd, ['run', 'build:app']);

  if (!fs.existsSync(androidDir)) {
    throw new Error('Android project folder is missing (`android/`).');
  }

  if (!javaHome) {
    throw new Error('Java was not found. Install Android Studio (or JDK) and set JAVA_HOME before using one-click APK publish.');
  }

  const gradleEnv = {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
  };
  logs.push(`Using JAVA_HOME: ${javaHome}`);

  logs.push('Building Android debug APK...');
  if (process.platform === 'win32') {
    await runCommand('cmd.exe', ['/d', '/s', '/c', 'gradlew.bat', 'assembleDebug'], { cwd: androidDir, env: gradleEnv });
  } else {
    await runCommand('./gradlew', ['assembleDebug'], { cwd: androidDir, env: gradleEnv });
  }

  const candidates = [
    path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
  ];
  const sourceApkPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!sourceApkPath) {
    throw new Error('Android build finished but no APK was found in `android/app/build/outputs/apk`.');
  }

  fs.mkdirSync(publicDir, { recursive: true });
  fs.copyFileSync(sourceApkPath, stagedApkPath);
  logs.push(`Staged APK for publish: ${stagedApkPath}`);

  return {
    sourceApkPath,
    stagedApkPath,
    relativePath: outputFileName,
  };
}

function writeDownloadPage({ appName, webAppUrl, androidDownloadUrl, publishUrl }) {
  const publicDir = path.join(projectRoot, 'public');
  const downloadHtmlPath = path.join(publicDir, 'download.html');
  fs.mkdirSync(publicDir, { recursive: true });

  const safeAppName = htmlEscape(appName || 'Hydrate');
  const safeWebAppUrl = htmlEscape(webAppUrl);
  const safeAndroidDownloadUrl = htmlEscape(androidDownloadUrl);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeAppName} Downloads</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1218; color: #e6edf3; font-family: Consolas, 'Courier New', monospace; }
      main { width: min(520px, calc(100vw - 32px)); border: 1px solid #2f3742; border-radius: 12px; background: #151b24; padding: 20px; text-align: center; }
      h1 { margin: 0 0 14px; font-size: 1.35rem; }
      .actions { display: grid; gap: 12px; }
      .btn { display: block; padding: 12px 14px; border: 1px solid #364253; border-radius: 10px; background: #1b2430; color: #d8f0ff; text-decoration: none; font-size: 0.95rem; }
      .btn.primary { border-color: #4b7ecf; background: #21314f; }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeAppName}</h1>
      <div class="actions">
        <a class="btn primary" href="${safeAndroidDownloadUrl}">Download APK</a>
        <a class="btn" href="${safeWebAppUrl}">Back to Glasses</a>
      </div>
    </main>
  </body>
</html>`;

  fs.writeFileSync(downloadHtmlPath, html, 'utf8');
  return downloadHtmlPath;
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

function openPath(targetPath) {
  const child = spawn('cmd', ['/c', 'start', '""', targetPath], {
    cwd: projectRoot,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function runCommand(command, args, options = {}) {
  const spawnOnce = (cmd, cmdArgs, extra = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, cmdArgs, {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
        ...extra,
      });

      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      child.on('error', (err) => {
        err.output = output;
        reject(err);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(output || `${cmd} ${cmdArgs.join(' ')} failed with code ${code}`));
        }
      });
    });

  return (async () => {
    try {
      return await spawnOnce(command, args);
    } catch (error) {
      if (process.platform === 'win32' && String(error?.code || '') === 'EINVAL') {
        // Windows fallback for sporadic spawn EINVAL from .cmd invocations.
        return await spawnOnce('cmd.exe', ['/d', '/s', '/c', command, ...args]);
      }
      throw error;
    }
  })();
}

async function runEhpkBuild(appNameRaw) {
  const logs = [];
  const appName = String(appNameRaw || '').trim() || 'even-g2-app';
  const ehpkName = appName.slice(0, 20);
  const safeName = sanitizeRepoName(appName);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const appJsonPath = path.join(projectRoot, 'app.json');
  const distPath = path.join(projectRoot, 'dist');
  const outputDir = path.join(projectRoot, 'ehpk');
  const outputFile = `${safeName}.ehpk`;
  const outputPath = path.join(outputDir, outputFile);

  logs.push('Building web app (dist)...');
  await runCommand(npmCmd, ['run', 'build']);

  if (!fs.existsSync(appJsonPath)) {
    logs.push('app.json not found. Creating with evenhub init...');
    await runCommand(npxCmd, ['@evenrealities/evenhub-cli', 'init', '--output', 'app.json']);
  }

  if (!fs.existsSync(distPath)) {
    throw new Error('dist folder missing after build. Cannot pack .ehpk.');
  }

  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  if (appName !== ehpkName) {
    logs.push(`App name trimmed for EHPK (max 20 chars): "${appName}" -> "${ehpkName}"`);
  }
  appJson.name = ehpkName;
  appJson.entrypoint = 'index.html';
  appJson.version = String(appJson.version || '0.1.0');
  if (!appJson.package_id || String(appJson.package_id).includes('example')) {
    appJson.package_id = `com.${safeName.replace(/[^a-z0-9.]/g, '') || 'eveng2app'}`;
  }
  fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`, 'utf8');

  fs.mkdirSync(outputDir, { recursive: true });

  logs.push(`Packing .ehpk (${outputFile})...`);
  const packOutput = await runCommand(npxCmd, [
    '@evenrealities/evenhub-cli',
    'pack',
    'app.json',
    'dist',
    '--output',
    outputPath,
  ]);

  if (/invalid app\.json/i.test(String(packOutput))) {
    throw new Error(`EHPK pack failed: ${String(packOutput).trim()}`);
  }

  let finalOutputPath = outputPath;
  if (!fs.existsSync(finalOutputPath)) {
    const candidates = fs
      .readdirSync(outputDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.ehpk'))
      .map((d) => path.join(outputDir, d.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length > 0) {
      finalOutputPath = candidates[0];
    } else {
      throw new Error(
        `EHPK pack reported success but no output file was created. CLI output:\n${String(packOutput).trim()}`,
      );
    }
  }

  logs.push(`Created package: ${finalOutputPath}`);
  openPath(outputDir);

  return {
    logs: logs.join('\n'),
    outputPath: finalOutputPath,
    outputFile,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const webAppUrl = publishUrl;
  const downloadPageUrl = `${publishUrl}download.html`;

  // Create repo if needed.
  const createRepoResult = await githubApi({
    token,
    method: 'POST',
    pathName: '/user/repos',
    body: {
      name: repo,
      private: true,
      auto_init: false,
    },
  });

  const repoCreated = createRepoResult.response.status === 201;
  if (repoCreated) {
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
  config.webAppUrl = webAppUrl;
  config.downloadPageUrl = downloadPageUrl;
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

  const configWithUrls = readConfig();
  const explicitAndroidDownloadUrl = String(configWithUrls.androidDownloadUrl ?? '').trim();
  const fallbackReleaseUrl = `${remoteUrl.replace(/\.git$/i, '')}/releases/latest`;
  const stagedApkRelativePath = 'hydrate-latest.apk';
  const stagedApkPath = path.join(projectRoot, 'public', stagedApkRelativePath);
  let androidDownloadUrl = explicitAndroidDownloadUrl;
  if (!androidDownloadUrl && fs.existsSync(stagedApkPath)) {
    androidDownloadUrl = `${publishUrl}${stagedApkRelativePath}`;
  }
  if (!androidDownloadUrl) {
    androidDownloadUrl = fallbackReleaseUrl;
  }
  const writtenDownloadPath = writeDownloadPage({
    appName,
    webAppUrl,
    androidDownloadUrl,
    publishUrl,
  });
  logs.push(`Generated download page: ${writtenDownloadPath}`);
  logs.push(`Web app URL: ${webAppUrl}`);
  logs.push(`Android download page URL: ${downloadPageUrl}`);
  logs.push(`Android binary source URL: ${androidDownloadUrl}`);

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

  async function setRepoVisibility(isPrivate) {
    const patchRes = await githubApi({
      token,
      method: 'PATCH',
      pathName: `/repos/${owner}/${repo}`,
      body: { private: isPrivate },
    });
    return patchRes.response.ok;
  }

  async function enablePagesOnce() {
    const putRes = await githubApi({
      token,
      method: 'PUT',
      pathName: `/repos/${owner}/${repo}/pages`,
      body: { build_type: 'workflow' },
    });
    if (putRes.response.ok) {
      return { ok: true, via: 'PUT', status: putRes.response.status, text: putRes.text };
    }

    const postRes = await githubApi({
      token,
      method: 'POST',
      pathName: `/repos/${owner}/${repo}/pages`,
      body: { build_type: 'workflow' },
    });
    if (postRes.response.ok || postRes.response.status === 409) {
      return { ok: true, via: 'POST', status: postRes.response.status, text: postRes.text };
    }

    return {
      ok: false,
      via: 'POST',
      status: postRes.response.status,
      text: postRes.text || putRes.text,
      putStatus: putRes.response.status,
      putText: putRes.text,
    };
  }

  async function pagesIsActive() {
    const pagesGet = await githubApi({
      token,
      method: 'GET',
      pathName: `/repos/${owner}/${repo}/pages`,
    });
    return pagesGet.response.ok;
  }

  // GitHub Pages deploy is most reliable for public repos in this workflow.
  // Keep publish fully automated by switching to public before enabling Pages.
  const madePublic = await setRepoVisibility(false);
  if (!madePublic) {
    logs.push('Warning: could not force repo public before enabling Pages. Continuing...');
  } else {
    logs.push('Repo visibility set to public for Pages deployment.');
  }

  // Enable Pages with workflow build type and verify activation (with retries).
  let enabled = false;
  let lastEnableErr = '';
  for (let i = 0; i < 5; i += 1) {
    const pagesEnable = await enablePagesOnce();
    if (!pagesEnable.ok) {
      lastEnableErr = String(pagesEnable.text || pagesEnable.status || 'unknown');
      await sleep(2000);
      continue;
    }

    if (await pagesIsActive()) {
      enabled = true;
      break;
    }
    await sleep(3000);
  }

  if (!enabled) {
    throw new Error(`Unable to enable GitHub Pages automatically: ${lastEnableErr || 'not active after retries'}`);
  }
  logs.push('GitHub Pages enabled and active');

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

  await generateQrForUrl(webAppUrl);
  if (repoCreated) {
    logs.push('First publish detected. Waiting 35s before opening site...');
    await sleep(35000);
  }
  logs.push('Waiting for published site to become available...');
  const siteReady = await waitForPublishedUrl(publishUrl, 90000, 3000);
  if (siteReady) {
    logs.push('Published site is live.');
  } else {
    logs.push('Publish URL still propagating; opening anyway.');
  }
  openUrl(webAppUrl);

  return {
    logs: logs.join('\n'),
    publishUrl,
    webAppUrl,
    downloadPageUrl,
    androidDownloadUrl,
    remoteUrl,
    owner,
    repo,
  };
}

async function runBuildApk(existingLogs = null) {
  const logs = Array.isArray(existingLogs) ? existingLogs : [];
  const staged = await buildAndStageAndroidApk(logs);

  const config = readConfig();
  const publishUrl = String(config.publishUrl ?? '').trim();
  const webAppUrl = String(config.webAppUrl ?? publishUrl).trim() || './';
  const androidDownloadUrl = publishUrl ? `${publishUrl}${staged.relativePath}` : `./${staged.relativePath}`;

  config.androidDownloadUrl = androidDownloadUrl;
  writeConfig(config);

  if (publishUrl) {
    const writtenDownloadPath = writeDownloadPage({
      appName: String(config.appName ?? 'Hydrate'),
      webAppUrl,
      androidDownloadUrl,
      publishUrl,
    });
    logs.push(`Updated download page: ${writtenDownloadPath}`);
  }

  logs.push(`APK ready: ${staged.stagedApkPath}`);
  logs.push(`Android binary source URL: ${androidDownloadUrl}`);

  return {
    logs: logs.join('\n'),
    stagedApkPath: staged.stagedApkPath,
    androidDownloadUrl,
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
      capabilities: ['publish', 'publish-app', 'build-apk', 'reboot', 'link-git', 'switch-git-account', 'build-ehpk', 'todoist'],
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

  if (req.method === 'POST' && req.url === '/build-ehpk') {
    if (ehpkRunning) {
      sendJson(res, 409, { ok: false, error: 'EHPK build already running' });
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', async () => {
      ehpkRunning = true;
      try {
        const payload = body ? JSON.parse(body) : {};
        const appName = String(payload.appName ?? '').trim() || 'even-g2-app';
        const result = await runEhpkBuild(appName);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      } finally {
        ehpkRunning = false;
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/build-apk') {
    if (apkBuildRunning) {
      sendJson(res, 409, {
        ok: false,
        error: 'APK build already running',
        state: apkBuildStatus.state,
        logs: apkBuildStatus.logs.join('\n'),
      });
      return;
    }

    apkBuildRunning = true;
    apkBuildStatus = {
      state: 'RUNNING',
      logs: [`[${new Date().toLocaleTimeString()}] Build APK started...`],
      startedAt: new Date().toISOString(),
      finishedAt: '',
      error: '',
      result: null,
    };

    void (async () => {
      try {
        const result = await runBuildApk(apkBuildStatus.logs);
        apkBuildStatus.state = 'DONE';
        apkBuildStatus.result = result;
        apkBuildStatus.logs.push(`[${new Date().toLocaleTimeString()}] Build APK completed.`);
      } catch (error) {
        apkBuildStatus.state = 'FAILED';
        apkBuildStatus.error = String(error);
        apkBuildStatus.logs.push(`[${new Date().toLocaleTimeString()}] Build APK failed: ${String(error)}`);
      } finally {
        apkBuildRunning = false;
        apkBuildStatus.finishedAt = new Date().toISOString();
      }
    })();

    sendJson(res, 202, { ok: true, state: 'RUNNING', message: 'APK build started' });
    return;
  }

  if (req.method === 'GET' && req.url === '/build-apk-status') {
    sendJson(res, 200, {
      ok: true,
      state: apkBuildStatus.state,
      running: apkBuildRunning,
      startedAt: apkBuildStatus.startedAt,
      finishedAt: apkBuildStatus.finishedAt,
      error: apkBuildStatus.error,
      logs: apkBuildStatus.logs.join('\n'),
      result: apkBuildStatus.result,
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

  // ── Todoist proxy ────────────────────────────────────────────────────────

  if (req.method === 'POST' && req.url === '/todoist/token') {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const token = String(payload.token ?? '').trim();
        const projectId = String(payload.projectId ?? '').trim();
        const secrets = readLocalSecrets();
        secrets.todoistToken = token;
        secrets.todoistProjectId = projectId;
        writeLocalSecrets(secrets);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    });
    return;
  }

  const closeTaskMatch = req.url.match(/^\/todoist\/tasks\/([^/]+)\/close$/);
  if (req.method === 'POST' && closeTaskMatch) {
    const taskId = closeTaskMatch[1];
    const secrets = readLocalSecrets();
    const token = String(secrets.todoistToken ?? '').trim();
    if (!token) {
      sendJson(res, 400, { ok: false, error: 'TODOIST_TOKEN_REQUIRED' });
      return;
    }
    try {
      const response = await fetch(
        `https://api.todoist.com/rest/v2/tasks/${encodeURIComponent(taskId)}/close`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.status === 204 || response.ok) {
        sendJson(res, 200, { ok: true });
      } else {
        const text = await response.text().catch(() => '');
        sendJson(res, response.status, { ok: false, error: `Todoist close failed: ${response.status}`, detail: text });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/todoist/tasks')) {
    const secrets = readLocalSecrets();
    const token = String(secrets.todoistToken ?? '').trim();
    if (!token) {
      sendJson(res, 400, { ok: false, error: 'TODOIST_TOKEN_REQUIRED' });
      return;
    }
    const urlObj = new URL(req.url, `http://${host}`);
    const projectId = urlObj.searchParams.get('project_id') ?? '';
    const apiUrl = projectId
      ? `https://api.todoist.com/rest/v2/tasks?project_id=${encodeURIComponent(projectId)}`
      : 'https://api.todoist.com/rest/v2/tasks';
    try {
      const response = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        sendJson(res, response.status, { ok: false, error: `Todoist API error: ${response.status}`, detail: json });
        return;
      }
      sendJson(res, 200, { ok: true, tasks: json });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(port, host, () => {
  console.log(`[control] listening on http://${host}:${port}`);
});
