import './style.css';
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

type InputAction = 'CLICK' | 'UP' | 'DOWN' | 'DOUBLE_CLICK';
type PomodoroMode = 'FOCUS' | 'BREAK';
type TransitionMode = 'AUTO' | 'MANUAL';

type AppState = {
  mode: PomodoroMode;
  remainingSeconds: number;
  running: boolean;
  publishStatus: string;
  deployed: boolean;
  transitionMode: TransitionMode;
  inTransition: boolean;
  pendingMode: PomodoroMode | null;
  transitionRemainingSeconds: number;
  transitionElapsedMs: number;
  flashAlternate: boolean;
  flashIntervalMs: number;
  flashCharA: string;
  flashCharB: string;
  flashQtyA: number;
  flashQtyB: number;
  transitionSeconds: number;
  focusMinutes: number;
  breakMinutes: number;
};

const MAIN_CONTAINER_ID = 1;
const MAIN_CONTAINER_NAME = 'mainText';
const CONTROL_URL = 'http://127.0.0.1:8787';
const REQUIRED_CONTROL_CAPABILITY = 'publish-app';
const DEFAULT_FOCUS_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;
const TRANSITION_SECONDS = 10;
const DISPLAY_WIDTH = 576;
const MAIN_PANEL_X = 24;
const MAIN_PANEL_WIDTH = 528;
const FLASH_ROWS = 10;
const TICK_INTERVAL_MS = 50;
const HIDE_DEBUG_TOOLS = true;
const DEV_TOOLS_TOGGLE_SHORTCUT = 'Ctrl+Shift+D';

const state: AppState = {
  mode: 'FOCUS',
  remainingSeconds: DEFAULT_FOCUS_MINUTES * 60,
  running: false,
  publishStatus: 'IDLE',
  deployed: false,
  transitionMode: 'AUTO',
  inTransition: false,
  pendingMode: null,
  transitionRemainingSeconds: 0,
  transitionElapsedMs: 0,
  flashAlternate: true,
  flashIntervalMs: 250,
  flashCharA: '\u25A7',
  flashCharB: ' ',
  flashQtyA: 26,
  flashQtyB: 26,
  transitionSeconds: TRANSITION_SECONDS,
  focusMinutes: DEFAULT_FOCUS_MINUTES,
  breakMinutes: DEFAULT_BREAK_MINUTES,
};

let bridge: EvenAppBridge | null = null;
let startupCreated = false;
let lastTickMs = Date.now();
let lastResolvedAction: InputAction | null = null;
let lastResolvedActionAt = 0;
let lastEventSignature = '';
let lastEventAt = 0;
let lastEventLabel = '';
let debugToolsVisible = !HIDE_DEBUG_TOOLS;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root element');

app.innerHTML = `
  <main class="hud-shell">
    <fieldset class="group-box">
      <legend>User Settings</legend>

      <fieldset class="group-box compact-box">
        <legend>Durations</legend>
        <div class="settings-row">
          <div class="mini-field">
            <label for="focus-minutes">Focus</label>
            <input id="focus-minutes" type="number" min="0" max="180" step="0.1" value="${DEFAULT_FOCUS_MINUTES}" />
            <span class="field-unit">mins</span>
          </div>
        </div>
        <div class="settings-row">
          <div class="mini-field">
            <label for="break-minutes">Break</label>
            <input id="break-minutes" type="number" min="0" max="180" step="0.1" value="${DEFAULT_BREAK_MINUTES}" />
            <span class="field-unit">mins</span>
          </div>
        </div>
      </fieldset>

      <fieldset class="group-box compact-box">
        <legend>Transition</legend>
        <div class="settings-row">
          <div class="mini-field">
            <label for="transition-mode">Method</label>
            <select id="transition-mode">
              <option value="AUTO">AUTO</option>
              <option value="MANUAL">MANUAL</option>
            </select>
          </div>
          <div class="mini-field">
            <label for="transition-seconds">Sec</label>
            <input id="transition-seconds" type="number" min="1" max="300" value="${TRANSITION_SECONDS}" />
          </div>
        </div>

        <fieldset class="group-box compact-box">
          <legend>Flash A</legend>
          <div class="settings-row">
            <div class="mini-field">
              <label for="flash-char-a">Char</label>
              <input id="flash-char-a" type="text" maxlength="1" value="" />
            </div>
            <div class="mini-field">
              <label for="flash-qty-a">Qty</label>
              <input id="flash-qty-a" type="number" min="1" max="80" value="26" />
            </div>
          </div>
        </fieldset>

        <fieldset class="group-box compact-box flash-b-box" id="alternate-block">
            <legend>
              <label class="legend-toggle" for="flash-alternate">
                <span>FLASH B</span>
                <input id="flash-alternate" type="checkbox" checked />
              </label>
            </legend>
            <div class="group-box-body">
              <div class="settings-row">
                <div class="mini-field">
                  <label for="flash-interval-ms">Flash</label>
                  <input id="flash-interval-ms" type="number" min="50" max="10000" step="50" value="250" />
                  <span class="field-unit">ms</span>
                </div>
                <div class="mini-field">
                  <label for="flash-char-b">Char</label>
                  <input id="flash-char-b" type="text" maxlength="1" value="" />
                </div>
                <div class="mini-field">
                  <label for="flash-qty-b">Qty</label>
                  <input id="flash-qty-b" type="number" min="1" max="80" value="26" />
                </div>
              </div>
            </div>
          </fieldset>
      </fieldset>

    </fieldset>

    <fieldset id="debug-tools" class="group-box" ${HIDE_DEBUG_TOOLS ? 'style="display:none;"' : ''}>
      <legend>Debug Tools</legend>
      <div class="controls">
        <button id="publish-btn" type="button">Publish App</button>
        <button id="ehpk-btn" type="button">Build EHPK</button>
        <span id="publish-status">IDLE</span>
      </div>
      <pre id="event-log" class="event-log"></pre>
      <pre id="publish-log" class="publish-log"></pre>
      
      <div class="sim-display">
        <pre id="hud-main-preview" class="hud-preview hud-preview-main"></pre>
      </div>
      <p class="hint">Input: Click=start/pause, Double-click=reset, Up=Focus, Down=Break</p>
    </fieldset>

  </main>
`;

const hudMainPreview = document.querySelector<HTMLPreElement>('#hud-main-preview')!;
const publishBtn = document.querySelector<HTMLButtonElement>('#publish-btn')!;
const ehpkBtn = document.querySelector<HTMLButtonElement>('#ehpk-btn')!;
const debugToolsFieldset = document.querySelector<HTMLElement>('#debug-tools')!;
const focusMinutesInput = document.querySelector<HTMLInputElement>('#focus-minutes')!;
const breakMinutesInput = document.querySelector<HTMLInputElement>('#break-minutes')!;
const transitionModeSelect = document.querySelector<HTMLSelectElement>('#transition-mode')!;
const transitionSecondsInput = document.querySelector<HTMLInputElement>('#transition-seconds')!;
const flashAlternateInput = document.querySelector<HTMLInputElement>('#flash-alternate')!;
const flashIntervalMsInput = document.querySelector<HTMLInputElement>('#flash-interval-ms')!;
const flashCharAInput = document.querySelector<HTMLInputElement>('#flash-char-a')!;
const flashCharBInput = document.querySelector<HTMLInputElement>('#flash-char-b')!;
const flashQtyAInput = document.querySelector<HTMLInputElement>('#flash-qty-a')!;
const flashQtyBInput = document.querySelector<HTMLInputElement>('#flash-qty-b')!;
const alternateBlock = document.querySelector<HTMLElement>('#alternate-block')!;
const publishStatus = document.querySelector<HTMLSpanElement>('#publish-status')!;
const eventLog = document.querySelector<HTMLPreElement>('#event-log')!;
const publishLog = document.querySelector<HTMLPreElement>('#publish-log')!;
const eventLines: string[] = [];
const DISPLAY_COLUMNS = 52;

const mainPanelLeftPercent = (MAIN_PANEL_X / DISPLAY_WIDTH) * 100;
const mainPanelWidthPercent = (MAIN_PANEL_WIDTH / DISPLAY_WIDTH) * 100;
hudMainPreview.style.left = `${mainPanelLeftPercent}%`;
hudMainPreview.style.width = `${mainPanelWidthPercent}%`;

function secondsForMode(mode: PomodoroMode): number {
  if (mode === 'FOCUS') {
    return Math.max(1, Math.round(state.focusMinutes * 60));
  }
  return Math.max(1, Math.round(state.breakMinutes * 60));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function charCellWidth(char: string): number {
  const code = (char || '#').codePointAt(0) ?? 35;

  // Simulator/G2 text behaves closer to fixed cells than browser pixels.
  // Block glyphs commonly occupy ~2 cells while ASCII takes ~1.
  if (code >= 0x2580 && code <= 0x259f) return 2; // Block Elements
  if (code >= 0x25a0 && code <= 0x25ff) return 2; // Geometric Shapes
  if (code >= 0x2500 && code <= 0x257f) return 2; // Box Drawing
  if (code >= 0xff01 && code <= 0xff60) return 2; // Full-width forms
  return 1;
}

function estimateQtyForChar(char: string): number {
  const width = charCellWidth((char || '#').slice(0, 1));
  return clampInt(Math.floor(DISPLAY_COLUMNS / width), 1, 80);
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function resetCurrentMode(): void {
  state.remainingSeconds = secondsForMode(state.mode);
  state.inTransition = false;
  state.pendingMode = null;
  state.transitionRemainingSeconds = 0;
  state.transitionElapsedMs = 0;
  lastTickMs = Date.now();
}

function setMode(mode: PomodoroMode): void {
  state.mode = mode;
  state.running = false;
  resetCurrentMode();
}

function toggleRunPause(): void {
  if (state.inTransition && state.transitionMode === 'MANUAL' && state.pendingMode) {
    completeTransition(true);
    return;
  }
  if (state.inTransition) return;
  state.running = !state.running;
  lastTickMs = Date.now();
}

function startTransition(nextMode: PomodoroMode): void {
  state.inTransition = true;
  state.pendingMode = nextMode;
  state.running = false;
  state.transitionElapsedMs = 0;

  if (state.transitionMode === 'MANUAL') {
    state.transitionRemainingSeconds = 0;
  } else {
    state.transitionRemainingSeconds = state.transitionSeconds;
  }

  lastTickMs = Date.now();
}

function completeTransition(startRunning: boolean): void {
  if (!state.pendingMode) return;
  state.mode = state.pendingMode;
  state.pendingMode = null;
  state.inTransition = false;
  state.transitionRemainingSeconds = 0;
  state.transitionElapsedMs = 0;
  state.remainingSeconds = secondsForMode(state.mode);
  state.running = startRunning;
  lastTickMs = Date.now();
}

function buildFullFlashText(char: string, qty: number, rows: number): string {
  const safeChar = (char && char.length > 0 ? char : '#').slice(0, 1);
  const safeQty = Math.max(1, Math.floor(qty));
  const safeRows = Math.max(1, Math.floor(rows));
  const line = safeChar.repeat(safeQty);
  return Array.from({ length: safeRows }, () => line).join('\n');
}

function getCurrentFlashSpec(): { char: string; qty: number } {
  if (!state.flashAlternate) {
    return { char: state.flashCharA, qty: state.flashQtyA };
  }

  const intervalMs = Math.max(50, Math.floor(state.flashIntervalMs));
  const phase = Math.floor(state.transitionElapsedMs / intervalMs) % 2;
  if (phase === 0) {
    return { char: state.flashCharA, qty: state.flashQtyA };
  }
  return { char: state.flashCharB, qty: state.flashQtyB };
}

function buildMainHudText(): string {
  if (state.inTransition && state.pendingMode) {
    if (state.transitionMode === 'MANUAL') {
      const totalMs = Math.max(1, Math.floor(state.transitionSeconds * 1000));
      if (state.transitionElapsedMs >= totalMs) {
        return [
          `${state.mode} -> ${state.pendingMode}`,
          'CLICK to continue',
        ].join('\n');
      }
    }

    const spec = getCurrentFlashSpec();
    return buildFullFlashText(spec.char, spec.qty, FLASH_ROWS);
  }

  return [
    state.mode, ':',
    state.running ? "▶" : "ll",
    formatTime(state.remainingSeconds)
  ].join(' ');
}

async function pushHudToEvenHub(): Promise<void> {
  if (!bridge || !startupCreated) return;

  const mainContent = buildMainHudText();

  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: MAIN_CONTAINER_ID,
      containerName: MAIN_CONTAINER_NAME,
      contentOffset: 0,
      contentLength: mainContent.length,
      content: mainContent,
    }),
  );
}

async function render(): Promise<void> {
  hudMainPreview.textContent = buildMainHudText();
  publishStatus.textContent = state.publishStatus;
  publishBtn.textContent = state.deployed ? 'Update App' : 'Publish App';
  alternateBlock.classList.toggle('collapsed', !state.flashAlternate);

  try {
    await pushHudToEvenHub();
  } catch (error) {
    console.error('Failed to push HUD update to Even Hub:', error);
  }
}

function tickPomodoro(): void {
  const now = Date.now();
  const deltaMs = now - lastTickMs;
  if (deltaMs <= 0) {
    return;
  }

  if (state.inTransition) {
    lastTickMs = now;
    state.transitionElapsedMs += deltaMs;
    if (state.transitionMode === 'AUTO') {
      const totalMs = Math.max(1, Math.floor(state.transitionSeconds * 1000));
      const remainingMs = Math.max(0, totalMs - state.transitionElapsedMs);
      state.transitionRemainingSeconds = remainingMs / 1000;

      if (remainingMs <= 0 && state.pendingMode) {
        completeTransition(true);
      }
    } else {
      // Manual mode flashes first, then waits for click to continue.
      state.transitionRemainingSeconds = 0;
    }

    void render();
    return;
  }

  if (!state.running) {
    return;
  }

  const deltaSeconds = Math.floor(deltaMs / 1000);
  if (deltaSeconds <= 0) {
    return;
  }

  lastTickMs += deltaSeconds * 1000;
  state.remainingSeconds -= deltaSeconds;

  while (state.remainingSeconds <= 0) {
    const nextMode: PomodoroMode = state.mode === 'FOCUS' ? 'BREAK' : 'FOCUS';
    startTransition(nextMode);
    break;
  }

  void render();
}

async function applyAction(action: InputAction): Promise<void> {
  if (action === 'CLICK') {
    console.log('CLICK');
    toggleRunPause();
  } else if (action === 'DOUBLE_CLICK') {
    state.running = false;
    resetCurrentMode();
  } else if (action === 'UP') {
    setMode('FOCUS');
  } else if (action === 'DOWN') {
    setMode('BREAK');
  }

  await render();
}

function mapEventTypeToAction(eventType: unknown): InputAction | null {
  if (eventType === undefined || eventType === null) return null;

  const normalized = OsEventTypeList.fromJson?.(eventType);
  if (normalized === OsEventTypeList.CLICK_EVENT) return 'CLICK';
  if (normalized === OsEventTypeList.SCROLL_TOP_EVENT) return 'UP';
  if (normalized === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'DOWN';
  if (normalized === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'DOUBLE_CLICK';

  if (eventType === OsEventTypeList.CLICK_EVENT || eventType === 0) return 'CLICK';
  if (eventType === OsEventTypeList.SCROLL_TOP_EVENT || eventType === 1) return 'UP';
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT || eventType === 2) return 'DOWN';
  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT || eventType === 3) return 'DOUBLE_CLICK';

  const text = String(eventType).toUpperCase();
  if (text.includes('DOUBLE') && text.includes('CLICK')) return 'DOUBLE_CLICK';
  if (text.includes('DOUBLE') && text.includes('TAP')) return 'DOUBLE_CLICK';
  if (text.includes('SCROLL_TOP') || text === 'UP' || text.includes('SWIPE_UP')) return 'UP';
  if (text.includes('SCROLL_BOTTOM') || text === 'DOWN' || text.includes('SWIPE_DOWN')) return 'DOWN';
  if (text.includes('SINGLE') && text.includes('CLICK')) return 'CLICK';
  if (text.includes('SINGLE') && text.includes('TAP')) return 'CLICK';
  if (text.includes('TAP_EVENT') || text === 'TAP') return 'CLICK';
  if (text === 'CLICK' || text.includes('CLICK_EVENT')) return 'CLICK';

  return null;
}

function extractEventType(event: any): unknown {
  return (
    event?.listEvent?.eventType ??
    event?.textEvent?.eventType ??
    event?.sysEvent?.eventType ??
    event?.listEvent?.eventName ??
    event?.textEvent?.eventName ??
    event?.sysEvent?.eventName ??
    event?.listEvent?.type ??
    event?.textEvent?.type ??
    event?.sysEvent?.type ??
    event?.eventType ??
    event?.type ??
    event?.name
  );
}

function appendEventLog(line: string): void {
  eventLines.push(line);
  while (eventLines.length > 8) {
    eventLines.shift();
  }
  eventLog.textContent = eventLines.join('\n');
}

function shouldTreatEmptySysEventAsClick(event: any): boolean {
  const explicitType = extractEventType(event);
  if (mapEventTypeToAction(explicitType)) return false;

  const now = Date.now();
  if (lastResolvedAction === 'DOUBLE_CLICK' && now - lastResolvedActionAt < 350) return false;
  return true;
}

function isDuplicateEvent(event: any, eventLabel: string): boolean {
  const signature = JSON.stringify({
    listEvent: event?.listEvent ?? null,
    textEvent: event?.textEvent ?? null,
    sysEvent: event?.sysEvent ?? null,
    eventType: event?.eventType ?? null,
    type: event?.type ?? null,
  });

  const now = Date.now();
  if (eventLabel === lastEventLabel && signature === lastEventSignature && now - lastEventAt < 140) {
    return true;
  }

  lastEventLabel = eventLabel;
  lastEventSignature = signature;
  lastEventAt = now;
  return false;
}

async function createStartupPage(): Promise<void> {
  if (!bridge) return;

  const mainContent = buildMainHudText();
  const containerPayload = {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: MAIN_PANEL_X,
        yPosition: 0,
        width: MAIN_PANEL_WIDTH,
        height: 288,
        containerID: MAIN_CONTAINER_ID,
        containerName: MAIN_CONTAINER_NAME,
        content: mainContent,
        isEventCapture: 1,
      }),
    ],
  };

  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containerPayload));
  startupCreated = result === 0;
  if (startupCreated) {
    return;
  }

  console.warn('createStartUpPageContainer failed with code:', result, 'trying rebuildPageContainer...');
  const rebuildOk = await bridge.rebuildPageContainer(new RebuildPageContainer(containerPayload));
  startupCreated = !!rebuildOk;
  if (!startupCreated) {
    console.warn('rebuildPageContainer also failed');
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

  const savedRepoName = (configBody?.config?.github?.repo ?? '').trim();
  const defaultAppName = savedRepoName || configBody?.config?.appName || 'even-g2-pomodoro';
  let appName = defaultAppName;

  if (!savedRepoName) {
    const appNameInput = window.prompt('App name (used as GitHub repo name):', defaultAppName);
    appName = (appNameInput ?? '').trim();
    if (!appName) {
      publishLog.textContent = 'Publish cancelled: app name is required.';
      await render();
      return;
    }
  }

  state.publishStatus = 'RUNNING';
  publishBtn.disabled = true;
  ehpkBtn.disabled = true;
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
    ehpkBtn.disabled = false;
    await render();
  }
}

async function buildEhpk(): Promise<void> {
  if (state.publishStatus === 'RUNNING' || state.publishStatus === 'REBOOTING' || state.publishStatus === 'PACKING') {
    publishLog.textContent = 'Another operation is in progress. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configResponse?.json().catch(() => null)) as { config?: { appName?: string } } | null;
  const defaultAppName = (configBody?.config?.appName ?? 'even-g2-app').trim() || 'even-g2-app';

  const appNameInput = window.prompt('App name for .ehpk package:', defaultAppName);
  const appName = (appNameInput ?? '').trim();
  if (!appName) {
    publishLog.textContent = 'Build cancelled: app name is required.';
    await render();
    return;
  }

  state.publishStatus = 'PACKING';
  publishBtn.disabled = true;
  ehpkBtn.disabled = true;
  publishLog.textContent = `Building .ehpk for "${appName}"...`;
  await render();

  try {
    const response = await fetch(`${CONTROL_URL}/build-ehpk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName }),
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: string; logs?: string; outputPath?: string }
      | null;

    if (!response.ok) {
      if (response.status === 409) {
        state.publishStatus = 'PACKING';
        publishLog.textContent = 'EHPK build already running. Please wait for it to finish.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    state.publishStatus = 'DONE';
    publishLog.textContent = `${body?.logs ?? 'EHPK build complete.'}\n\nOutput:\n${body?.outputPath ?? 'unknown'}`;
  } catch (error) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    ehpkBtn.disabled = false;
    await render();
  }
}

function setKeyboardFallback(): void {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      debugToolsVisible = !debugToolsVisible;
      debugToolsFieldset.style.display = debugToolsVisible ? '' : 'none';
      console.log(`[debug-tools] ${debugToolsVisible ? 'shown' : 'hidden'} (${DEV_TOOLS_TOGGLE_SHORTCUT})`);
      return;
    }
    if (event.key === 'Enter') return void applyAction('CLICK');
    if (event.key.toLowerCase() === 'd') return void applyAction('DOUBLE_CLICK');
    if (event.key === 'ArrowUp') return void applyAction('UP');
    if (event.key === 'ArrowDown') return void applyAction('DOWN');
  });
}

async function init(): Promise<void> {
  setKeyboardFallback();
  publishBtn.addEventListener('click', () => void publishApp());
  ehpkBtn.addEventListener('click', () => void buildEhpk());

  transitionModeSelect.value = state.transitionMode;
  focusMinutesInput.value = String(state.focusMinutes);
  breakMinutesInput.value = String(state.breakMinutes);
  transitionSecondsInput.value = String(state.transitionSeconds);
  flashAlternateInput.checked = state.flashAlternate;
  flashIntervalMsInput.value = String(state.flashIntervalMs);
  flashCharAInput.value = state.flashCharA;
  flashCharBInput.value = state.flashCharB;
  flashQtyAInput.value = String(state.flashQtyA);
  flashQtyBInput.value = String(state.flashQtyB);

  const onFocusDurationChange = () => {
    state.focusMinutes = clampFloat(Number(focusMinutesInput.value), 0, 180);
    focusMinutesInput.value = String(state.focusMinutes);
    if (!state.running && !state.inTransition && state.mode === 'FOCUS') {
      state.remainingSeconds = secondsForMode('FOCUS');
    }
    void render();
  };

  const onBreakDurationChange = () => {
    state.breakMinutes = clampFloat(Number(breakMinutesInput.value), 0, 180);
    breakMinutesInput.value = String(state.breakMinutes);
    if (!state.running && !state.inTransition && state.mode === 'BREAK') {
      state.remainingSeconds = secondsForMode('BREAK');
    }
    void render();
  };

  focusMinutesInput.addEventListener('change', onFocusDurationChange);
  breakMinutesInput.addEventListener('change', onBreakDurationChange);

  transitionModeSelect.addEventListener('change', () => {
    state.transitionMode = transitionModeSelect.value === 'MANUAL' ? 'MANUAL' : 'AUTO';
    if (state.inTransition && state.transitionMode === 'AUTO' && state.transitionRemainingSeconds <= 0) {
      state.transitionRemainingSeconds = state.transitionSeconds;
      state.transitionElapsedMs = 0;
      lastTickMs = Date.now();
    }
    void render();
  });

  transitionSecondsInput.addEventListener('change', () => {
    const next = Math.max(1, Math.min(300, Number(transitionSecondsInput.value) || TRANSITION_SECONDS));
    state.transitionSeconds = next;
    transitionSecondsInput.value = String(next);
    void render();
  });

  flashAlternateInput.addEventListener('change', () => {
    state.flashAlternate = flashAlternateInput.checked;
    void render();
  });

  flashIntervalMsInput.addEventListener('change', () => {
    const next = Math.max(50, Math.min(10000, Number(flashIntervalMsInput.value) || 250));
    state.flashIntervalMs = next;
    flashIntervalMsInput.value = String(next);
    void render();
  });

  flashCharAInput.addEventListener('change', () => {
    state.flashCharA = (flashCharAInput.value || '#').slice(0, 1);
    flashCharAInput.value = state.flashCharA;
    state.flashQtyA = estimateQtyForChar(state.flashCharA);
    flashQtyAInput.value = String(state.flashQtyA);
    void render();
  });

  flashCharBInput.addEventListener('change', () => {
    state.flashCharB = (flashCharBInput.value || '#').slice(0, 1);
    flashCharBInput.value = state.flashCharB;
    state.flashQtyB = estimateQtyForChar(state.flashCharB);
    flashQtyBInput.value = String(state.flashQtyB);
    void render();
  });

  flashQtyAInput.addEventListener('change', () => {
    const next = Math.max(1, Math.min(80, Number(flashQtyAInput.value) || 26));
    state.flashQtyA = next;
    flashQtyAInput.value = String(next);
    void render();
  });

  flashQtyBInput.addEventListener('change', () => {
    const next = Math.max(1, Math.min(80, Number(flashQtyBInput.value) || 26));
    state.flashQtyB = next;
    flashQtyBInput.value = String(next);
    void render();
  });

  window.setInterval(tickPomodoro, TICK_INTERVAL_MS);

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

    await createStartupPage();
    const handleHubEvent = (event: any) => {
      const eventType = extractEventType(event);
      let action = mapEventTypeToAction(eventType);

      if (!action && event?.textEvent && !event?.listEvent && !event?.sysEvent) {
        action = 'CLICK';
      }

      if (!action && shouldTreatEmptySysEventAsClick(event)) {
        action = 'CLICK';
      }

      const eventLabel = action ?? 'NONE';
      if (isDuplicateEvent(event, eventLabel)) {
        return;
      }
      appendEventLog(`${new Date().toLocaleTimeString()}  ${eventLabel}`);

      if (action) {
        lastResolvedAction = action;
        lastResolvedActionAt = Date.now();
        console.log('[hub-event]', { action, eventType, event });
        void applyAction(action);
      }
    };

    bridge.onEvenHubEvent((event) => {
      handleHubEvent(event);
    });

    window.addEventListener('evenHubEvent', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      handleHubEvent(detail);
    });
  } catch (error) {
    console.warn('Even bridge not ready, using browser fallback mode:', error);
  }

  await render();
}

void init();
