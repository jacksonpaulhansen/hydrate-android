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
  deployed: boolean;
};

const MODES = ['Hello', 'World', 'G2 is Ready'];
const CONTAINER_ID = 1;
const CONTAINER_NAME = 'mainText';
const CONTROL_URL = 'http://127.0.0.1:8787';
const REQUIRED_CONTROL_CAPABILITY = 'publish-app';

const state: AppState = {
  modeIndex: 0,
  clickCount: 0,
  lastInput: 'NONE',
  connection: 'connecting',
  publishStatus: 'IDLE',
  deployed: false,
};

let bridge: EvenAppBridge | null = null;
let startupCreated = false;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root element');

app.innerHTML = `
  <main class="hud-shell">
    <pre id="hud-preview" class="hud-preview"></pre>
    <div class="controls">
      <button id="publish-btn" type="button">Publish App</button>
      <button id="reboot-btn" type="button">Reboot App</button>
      <span id="publish-status">IDLE</span>
    </div>
    <pre id="publish-log" class="publish-log"></pre>
    <p class="hint">Keyboard fallback: Enter=click, D=double-click, ArrowUp/ArrowDown</p>
  </main>
`;

const hudPreview = document.querySelector<HTMLPreElement>('#hud-preview')!;
const publishBtn = document.querySelector<HTMLButtonElement>('#publish-btn')!;
const rebootBtn = document.querySelector<HTMLButtonElement>('#reboot-btn')!;
const publishStatus = document.querySelector<HTMLSpanElement>('#publish-status')!;
const publishLog = document.querySelector<HTMLPreElement>('#publish-log')!;

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
  if (!bridge || !startupCreated) return;

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
  hudPreview.textContent = buildHudText();
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

  if (action === 'CLICK') state.clickCount += 1;
  if (action === 'UP') state.modeIndex = (state.modeIndex + MODES.length - 1) % MODES.length;
  if (action === 'DOWN') state.modeIndex = (state.modeIndex + 1) % MODES.length;
  if (action === 'DOUBLE_CLICK') {
    state.clickCount = 0;
    state.modeIndex = 0;
  }

  await render();
}

function mapEventTypeToAction(eventType?: OsEventTypeList): InputAction | null {
  if (eventType === undefined) return null;
  if (eventType === OsEventTypeList.CLICK_EVENT) return 'CLICK';
  if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) return 'UP';
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'DOWN';
  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'DOUBLE_CLICK';
  return null;
}

async function createStartupPage(): Promise<void> {
  if (!bridge) return;

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

async function publishApp(): Promise<void> {
  if (state.publishStatus === 'RUNNING') {
    publishLog.textContent = 'Publish is already running. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configResponse?.json().catch(() => null)) as
    | { config?: { appName?: string; github?: { repo?: string } } }
    | null;

  const defaultAppName = configBody?.config?.github?.repo || configBody?.config?.appName || 'even-g2-app';
  const appNameInput = window.prompt('App name (used as GitHub repo name):', defaultAppName);
  const appName = (appNameInput ?? '').trim();
  if (!appName) {
    publishLog.textContent = 'Publish cancelled: app name is required.';
    await render();
    return;
  }

  state.publishStatus = 'RUNNING';
  publishBtn.disabled = true;
  rebootBtn.disabled = true;
  publishLog.textContent = `Publishing "${appName}"...`;
  await render();

  try {
    let response = await fetch(`${CONTROL_URL}/publish-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName }),
    });

    let body = (await response.json().catch(() => null)) as
      | { error?: string; logs?: string; code?: string; publishUrl?: string }
      | null;

    if (!response.ok && (body?.code === 'PAT_REQUIRED' || body?.code === 'INVALID_PAT')) {
      const promptText =
        body?.code === 'INVALID_PAT'
          ? 'Saved PAT is invalid. Paste a new GitHub PAT:'
          : 'GitHub PAT required. Paste PAT:';
      const pat = window.prompt(promptText);
      if (!pat || !pat.trim()) {
        throw new Error('Publish cancelled: PAT is required.');
      }
      response = await fetch(`${CONTROL_URL}/publish-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName, pat: pat.trim() }),
      });
      body = (await response.json().catch(() => null)) as
        | { error?: string; logs?: string; publishUrl?: string }
        | null;
    }

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
    state.deployed = true;
    publishLog.textContent = `${body?.logs ?? 'Publish complete.'}\n\nPublished URL:\n${body?.publishUrl ?? 'unknown'}`;
  } catch (error) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    rebootBtn.disabled = false;
    await render();
  }
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
    const response = await fetch(`${CONTROL_URL}/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);

    publishLog.textContent = 'Reboot in progress... waiting for services, then reloading page.';
    await render();

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const [appPing, controlPing] = await Promise.all([
          fetch('http://127.0.0.1:5173', { cache: 'no-store' }),
          fetch(`${CONTROL_URL}/health`, { cache: 'no-store' }),
        ]);
        if (appPing.ok && controlPing.ok) {
          window.location.reload();
          return;
        }
      } catch {}
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

function setKeyboardFallback(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') return void applyAction('CLICK');
    if (event.key.toLowerCase() === 'd') return void applyAction('DOUBLE_CLICK');
    if (event.key === 'ArrowUp') return void applyAction('UP');
    if (event.key === 'ArrowDown') return void applyAction('DOWN');
  });
}

async function init(): Promise<void> {
  setKeyboardFallback();
  publishBtn.addEventListener('click', () => void publishApp());
  rebootBtn.addEventListener('click', () => void rebootApp());

  try {
    const health = await fetch(`${CONTROL_URL}/health`, { cache: 'no-store' });
    const info = (await health.json().catch(() => null)) as { capabilities?: string[]; version?: string } | null;
    if (!health.ok || !info?.capabilities?.includes(REQUIRED_CONTROL_CAPABILITY)) {
      publishLog.textContent = 'Control server is outdated. Run Run-Even-Sim.cmd to refresh local services.';
    } else {
      publishLog.textContent = `Control server ready (${info.version ?? 'unknown'})`;
    }
  } catch {
    publishLog.textContent = 'Control server not reachable. Run Run-Even-Sim.cmd.';
  }

  try {
    const response = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as { config?: { git?: { deployed?: boolean } } } | null;
    state.deployed = !!body?.config?.git?.deployed;
  } catch {}

  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Even bridge timeout')), 5000)),
    ]);

    state.connection = 'hub';
    await createStartupPage();
    bridge.onEvenHubEvent((event) => {
      const eventType = event.listEvent?.eventType ?? event.textEvent?.eventType ?? event.sysEvent?.eventType;
      const action = mapEventTypeToAction(eventType);
      if (action) void applyAction(action);
    });
  } catch (error) {
    console.warn('Even bridge not ready, using browser fallback mode:', error);
    state.connection = 'browser';
  }

  await render();
}

void init();
