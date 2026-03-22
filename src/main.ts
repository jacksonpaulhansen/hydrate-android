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
      <span id="publish-status">IDLE</span>
    </div>
    <p class="hint">Keyboard fallback: Enter=click, D=double-click, ArrowUp/ArrowDown</p>
  </main>
`;

const hudPreview = document.querySelector<HTMLPreElement>('#hud-preview')!;
const publishBtn = document.querySelector<HTMLButtonElement>('#publish-btn')!;
const publishStatus = document.querySelector<HTMLSpanElement>('#publish-status')!;

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
  state.publishStatus = 'RUNNING';
  await render();

  try {
    const response = await fetch('http://127.0.0.1:8787/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    state.publishStatus = 'DONE';
  } catch (error) {
    console.error('Publish failed:', error);
    state.publishStatus = 'FAILED';
  }

  await render();
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
