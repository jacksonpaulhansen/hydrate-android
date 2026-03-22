import './style.css';
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

type InputAction = 'CLICK' | 'UP' | 'DOWN' | 'DOUBLE_CLICK';

type AppState = {
  modeIndex: number;
  clickCount: number;
  lastInput: InputAction | 'NONE';
  connection: 'connecting' | 'hub' | 'browser';
  publishStatus: string;
  linkOpen: boolean;
  deployed: boolean;
};

const MODES = ['HELLO G2', 'READY', 'SIMULATOR'];
const CONTAINER_ID = 1;
const CONTAINER_NAME = 'mainText';

const state: AppState = {
  modeIndex: 0,
  clickCount: 0,
  lastInput: 'NONE',
  connection: 'connecting',
  publishStatus: 'IDLE',
  linkOpen: false,
  deployed: false,
};

let bridge: EvenAppBridge | null = null;
let startupCreated = false;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app root element');
}

app.innerHTML = `
  <main class="hud-shell">
    <pre id="hud-preview" class="hud-preview"></pre>
    <div class="controls">
      <button id="publish-btn" type="button">Publish</button>
      <button id="link-btn" type="button">Link Git/Repo</button>
      <button id="reboot-btn" type="button">Reboot App</button>
      <span id="publish-status">IDLE</span>
    </div>
    <section id="link-panel" class="link-panel hidden">
      <div class="link-grid">
        <input id="gh-user" placeholder="GitHub user" />
        <input id="gh-repo" placeholder="Repo name (or owner/repo)" />
      </div>
      <div class="link-actions">
        <button id="gh-login-btn" type="button">Open GitHub Login</button>
        <button id="gh-new-btn" type="button">Open Create Repo</button>
        <button id="switch-account-btn" type="button">Switch Git Account</button>
        <button id="save-link-btn" type="button">Save Link</button>
      </div>
    </section>
    <pre id="publish-log" class="publish-log"></pre>
    <p class="hint">Keyboard fallback: Enter=click, D=double-click, ArrowUp/ArrowDown</p>
  </main>
`;

const hudPreview = document.querySelector<HTMLPreElement>('#hud-preview')!;
const publishBtn = document.querySelector<HTMLButtonElement>('#publish-btn')!;
const linkBtn = document.querySelector<HTMLButtonElement>('#link-btn')!;
const rebootBtn = document.querySelector<HTMLButtonElement>('#reboot-btn')!;
const publishStatus = document.querySelector<HTMLSpanElement>('#publish-status')!;
const publishLog = document.querySelector<HTMLPreElement>('#publish-log')!;
const linkPanel = document.querySelector<HTMLElement>('#link-panel')!;
const ghUserInput = document.querySelector<HTMLInputElement>('#gh-user')!;
const ghRepoInput = document.querySelector<HTMLInputElement>('#gh-repo')!;
const ghLoginBtn = document.querySelector<HTMLButtonElement>('#gh-login-btn')!;
const ghNewBtn = document.querySelector<HTMLButtonElement>('#gh-new-btn')!;
const switchAccountBtn = document.querySelector<HTMLButtonElement>('#switch-account-btn')!;
const saveLinkBtn = document.querySelector<HTMLButtonElement>('#save-link-btn')!;
const requiredControlCapability = 'link-git';

function buildHudText(): string {
  const mode = MODES[state.modeIndex];
  return [
    mode,
    `CLICKS ${state.clickCount}`,
    `INPUT ${state.lastInput}`,
    `LINK ${state.connection.toUpperCase()}`,
    `PUB ${state.publishStatus}`,
  ].join('\n');
}

async function pushHudToEvenHub(): Promise<void> {
  if (!bridge || !startupCreated) {
    return;
  }

  const content = buildHudText();
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      contentOffset: 0,
      contentLength: content.length,
      content,
    }),
  );
}

async function render(): Promise<void> {
  const hudText = buildHudText();
  hudPreview.textContent = hudText;
  publishStatus.textContent = state.publishStatus;
  publishBtn.textContent = state.deployed ? 'Update App' : 'Publish App';

  try {
    await pushHudToEvenHub();
  } catch (error) {
    console.error('Failed to push HUD update to Even Hub:', error);
  }
}

async function applyAction(action: InputAction): Promise<void> {
  state.lastInput = action;

  if (action === 'CLICK') {
    state.clickCount += 1;
  }

  if (action === 'UP') {
    state.modeIndex = (state.modeIndex + MODES.length - 1) % MODES.length;
  }

  if (action === 'DOWN') {
    state.modeIndex = (state.modeIndex + 1) % MODES.length;
  }

  if (action === 'DOUBLE_CLICK') {
    state.clickCount = 0;
    state.modeIndex = 0;
  }

  await render();
}

function mapEventTypeToAction(eventType?: OsEventTypeList): InputAction | null {
  if (eventType === undefined) {
    return null;
  }

  if (eventType === OsEventTypeList.CLICK_EVENT) {
    return 'CLICK';
  }

  if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
    return 'UP';
  }

  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    return 'DOWN';
  }

  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    return 'DOUBLE_CLICK';
  }

  return null;
}

async function createStartupPage(): Promise<void> {
  if (!bridge) {
    return;
  }

  const content = buildHudText();
  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        content,
        isEventCapture: 1,
        }),
      ],
    }),
  );

  startupCreated = result === 0;
  if (!startupCreated) {
    console.warn('createStartUpPageContainer failed with code:', result);
  }
}

async function publishQr(): Promise<void> {
  if (state.publishStatus === 'RUNNING') {
    publishLog.textContent = 'Publish is already running. Please wait...';
    await render();
    return;
  }

  state.publishStatus = 'RUNNING';
  publishBtn.disabled = true;
  rebootBtn.disabled = true;
  publishLog.textContent = 'Publishing...';
  await render();

  try {
    const response = await fetch('http://127.0.0.1:8787/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const body = (await response.json().catch(() => null)) as { error?: string; logs?: string } | null;

    if (!response.ok) {
      if (response.status === 409) {
        state.publishStatus = 'RUNNING';
        publishLog.textContent = 'Publish already running. Please wait for it to complete.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    state.publishStatus = 'DONE';
    publishLog.textContent = body?.logs ?? 'Publish complete.';
    state.deployed = true;
  } catch (error) {
    console.error('Publish failed:', error);
    state.publishStatus = 'FAILED';
    const errorText = String(error);
    if (errorText.includes('Placeholder git config detected')) {
      state.linkOpen = true;
      linkPanel.classList.remove('hidden');
      publishLog.textContent =
        'Git config is still placeholder. Open Link Git/Repo, enter GitHub user + repo, then click Save Link, then Publish.';
    } else {
      publishLog.textContent = errorText;
    }
  }

  publishBtn.disabled = false;
  rebootBtn.disabled = false;
  await render();
}

async function rebootApp(): Promise<void> {
  if (state.publishStatus === 'RUNNING') {
    publishLog.textContent = 'Publish in progress. Wait for publish to finish before rebooting.';
    await render();
    return;
  }

  state.publishStatus = 'REBOOTING';
  publishBtn.disabled = true;
  rebootBtn.disabled = true;
  publishLog.textContent = 'Reboot requested. Services will restart now...';
  await render();

  try {
    const response = await fetch('http://127.0.0.1:8787/reboot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const body = (await response.json().catch(() => null)) as { error?: string; logs?: string } | null;
    if (!response.ok) {
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    publishLog.textContent = 'Reboot in progress... waiting for services, then reloading page.';
    await render();

    const deadline = Date.now() + 45000;
    let appReady = false;
    let controlReady = false;

    while (Date.now() < deadline) {
      try {
        const [appPing, controlPing] = await Promise.all([
          fetch('http://127.0.0.1:5173', { cache: 'no-store' }),
          fetch('http://127.0.0.1:8787/health', { cache: 'no-store' }),
        ]);
        appReady = appPing.ok;
        controlReady = controlPing.ok;
      } catch {
        appReady = false;
        controlReady = false;
      }

      if (appReady && controlReady) {
        window.location.reload();
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 800));
    }

    throw new Error('Reboot timeout: services did not become ready within 45s.');
  } catch (error) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Reboot failed: ${String(error)}`;
    publishBtn.disabled = false;
    rebootBtn.disabled = false;
    await render();
  }
}

async function linkGitRepo(): Promise<void> {
  state.linkOpen = !state.linkOpen;
  linkPanel.classList.toggle('hidden', !state.linkOpen);

  if (!state.linkOpen) {
    publishLog.textContent = 'Link panel closed.';
    await render();
    return;
  }

  publishLog.textContent = 'Loading current Git config...';
  try {
    const response = await fetch('http://127.0.0.1:8787/config', { cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      config?: {
        git?: { userName?: string; userEmail?: string; remoteUrl?: string };
      };
    } | null;
    if (!response.ok) {
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    const git = body?.config?.git ?? {};
    const remote = String(git.remoteUrl ?? '');
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/i);

    ghUserInput.value = match?.[1] ?? '';
    ghRepoInput.value = match?.[2] ?? '';

    publishLog.textContent = 'Edit fields, then click Save Link.';
  } catch (error) {
    publishLog.textContent = `Load config failed: ${String(error)}`;
  }
}

async function openGithub(mode: 'login' | 'new'): Promise<void> {
  try {
    const response = await fetch('http://127.0.0.1:8787/open-github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    publishLog.textContent =
      'GitHub page opened. This does NOT update app.config.json. Fill fields here and click Save Link.';
  } catch (error) {
    publishLog.textContent = `Open GitHub failed: ${String(error)}`;
  }
}

async function saveGitLink(): Promise<void> {
  const githubUser = ghUserInput.value.trim();
  const repoName = ghRepoInput.value.trim();

  if (!githubUser || !repoName) {
    publishLog.textContent = 'GitHub user and repo are required.';
    return;
  }

  saveLinkBtn.disabled = true;
  publishLog.textContent = 'Saving git link and local remote config...';
  try {
    const response = await fetch('http://127.0.0.1:8787/config/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubUser,
        repoName,
        branch: 'master',
      }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string; remoteUrl?: string; publishUrl?: string } | null;
    if (!response.ok) {
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    publishLog.textContent = `Linked: ${body?.remoteUrl}\nPublish URL: ${body?.publishUrl}\nNow click Publish.`;
    state.deployed = false;
    await render();
  } catch (error) {
    publishLog.textContent = `Save link failed: ${String(error)}`;
  } finally {
    saveLinkBtn.disabled = false;
  }
}

async function switchGitAccount(): Promise<void> {
  publishLog.textContent = 'Opening Git account switch flow...';
  try {
    const response = await fetch('http://127.0.0.1:8787/switch-git-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!response.ok) {
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    publishLog.textContent =
      'Git account switch launched. Sign in with the repo owner account, then try Publish again.';
  } catch (error) {
    publishLog.textContent = `Switch Git Account failed: ${String(error)}`;
  }
}

function setKeyboardFallback(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void applyAction('CLICK');
      return;
    }

    if (event.key.toLowerCase() === 'd') {
      void applyAction('DOUBLE_CLICK');
      return;
    }

    if (event.key === 'ArrowUp') {
      void applyAction('UP');
      return;
    }

    if (event.key === 'ArrowDown') {
      void applyAction('DOWN');
    }
  });
}

async function init(): Promise<void> {
  setKeyboardFallback();
  publishBtn.addEventListener('click', () => {
    void publishQr();
  });
  linkBtn.addEventListener('click', () => {
    void linkGitRepo();
  });
  ghLoginBtn.addEventListener('click', () => {
    void openGithub('login');
  });
  ghNewBtn.addEventListener('click', () => {
    void openGithub('new');
  });
  switchAccountBtn.addEventListener('click', () => {
    void switchGitAccount();
  });
  saveLinkBtn.addEventListener('click', () => {
    void saveGitLink();
  });
  rebootBtn.addEventListener('click', () => {
    void rebootApp();
  });

  try {
    const health = await fetch('http://127.0.0.1:8787/health', { cache: 'no-store' });
    const info = (await health.json().catch(() => null)) as { capabilities?: string[]; version?: string } | null;
    if (!health.ok || !info?.capabilities?.includes(requiredControlCapability)) {
      publishLog.textContent =
        'Control server is outdated. Run Run-Even-Sim.cmd to refresh local services.';
    } else {
      publishLog.textContent = `Control server ready (${info.version ?? 'unknown'})`;
    }
  } catch {
    publishLog.textContent = 'Control server not reachable. Run Run-Even-Sim.cmd.';
  }

  try {
    const response = await fetch('http://127.0.0.1:8787/config', { cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as { config?: { git?: { deployed?: boolean } } } | null;
    state.deployed = !!body?.config?.git?.deployed;
  } catch {}

  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('Even bridge timeout')), 5000);
      }),
    ]);

    state.connection = 'hub';
    await createStartupPage();

    bridge.onEvenHubEvent((event) => {
      const eventType =
        event.listEvent?.eventType ?? event.textEvent?.eventType ?? event.sysEvent?.eventType;

      const action = mapEventTypeToAction(eventType);
      if (action) {
        void applyAction(action);
      }
    });
  } catch (error) {
    console.warn('Even bridge not ready, using browser fallback mode:', error);
    state.connection = 'browser';
  }

  await render();
}

void init();
