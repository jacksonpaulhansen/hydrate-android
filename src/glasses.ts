import './style.css';
import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  type EvenAppBridge,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { User } from 'firebase/auth';
import {
  addEntry,
  clampInt,
  findNextQuickAmountIndex,
  loadHydrateState,
  progressPercent,
  removeEntry,
  saveHydrateState,
  touchState,
  type HydrateState,
  undoEntry,
} from './hydrate-shared';
import {
  bootstrapCloudSync,
  fetchRemoteState,
  isCloudSyncConfigured,
  listenForUserChange,
  pushRemoteState,
  signInWithGoogle,
  signOutFromCloud,
  subscribeToRemoteState,
} from './cloud-sync';

type InputAction = 'CLICK' | 'UP' | 'DOWN' | 'DOUBLE_CLICK';

const MAIN_CONTAINER_ID = 1;
const MAIN_CONTAINER_NAME = 'mainText';
const DISPLAY_WIDTH = 576;
const MAIN_PANEL_X = 24;
const MAIN_PANEL_WIDTH = 528;
const DISPLAY_COLUMNS = 52;
const DEV_TOOLS_TOGGLE_SHORTCUT = 'Ctrl+Shift+D';
const HIDE_DEBUG_TOOLS = true;
const CONTROL_URL = 'http://127.0.0.1:8787';
const REQUIRED_CONTROL_CAPABILITY = 'publish-app';
const MAX_APP_NAME_LENGTH = 20;
const BRIDGE_TIMEOUT_MS = 5000;

const state: HydrateState = loadHydrateState();
let bridge: EvenAppBridge | null = null;
let bridgeStatus = 'Connecting to Even Hub bridge...';
let deviceStatus = 'Waiting for glasses status';
let hudStatus = 'HUD not pushed yet';
let syncStatus = 'Waiting for cloud sync';
let debugVisible = !HIDE_DEBUG_TOOLS;
let launchSourceLabel = 'unknown';
let recentEventLines: string[] = ['Hydrate glasses companion booting'];
let pushInFlight = false;
let startupCreated = false;
let authStatus = isCloudSyncConfigured() ? 'Checking sign-in...' : 'Firebase config missing';
let currentUser: User | null = null;
let syncUnsubscribe: (() => void) | null = null;
let syncPollTimer: number | null = null;
let lastRemoteSeenAt = '';
let cloudPushQueued = false;
let cloudPushRunning = false;
let lastResolvedAction: InputAction | null = null;
let lastResolvedActionAt = 0;
let lastEventSignature = '';
let lastEventAt = 0;
let lastEventLabel = '';
let publishState: 'IDLE' | 'RUNNING' | 'PACKING' | 'DONE' | 'FAILED' = 'IDLE';
let deployed = false;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root element');

app.innerHTML = `
  <main class="hud-shell">
    <fieldset class="group-box collapsible">
      <legend>User Settings</legend>
      <div class="settings-grid">
        <div class="mini-field">
          <label for="daily-goal">Daily Goal</label>
          <input id="daily-goal" type="number" min="500" max="6000" step="50" />
          <span class="field-unit">ml</span>
        </div>
        <div class="mini-field">
          <label for="reminder-interval">Reminder</label>
          <input id="reminder-interval" type="number" min="1" max="240" step="1" />
          <span class="field-unit">mins</span>
        </div>
        <label class="toggle-field" for="reminder-enabled">
          <input id="reminder-enabled" type="checkbox" />
          <span>Enable reminders</span>
        </label>
      </div>
      <fieldset class="group-box compact-box">
        <legend>Quick Add Amounts</legend>
        <div class="settings-grid settings-grid-compact">
          <div class="mini-field"><label for="quick-amount-1">Preset 1</label><input id="quick-amount-1" type="number" min="50" max="2000" step="25" /><span class="field-unit">ml</span></div>
          <div class="mini-field"><label for="quick-amount-2">Preset 2</label><input id="quick-amount-2" type="number" min="50" max="2000" step="25" /><span class="field-unit">ml</span></div>
          <div class="mini-field"><label for="quick-amount-3">Preset 3</label><input id="quick-amount-3" type="number" min="50" max="2000" step="25" /><span class="field-unit">ml</span></div>
          <div class="mini-field"><label for="quick-amount-4">Preset 4</label><input id="quick-amount-4" type="number" min="50" max="2000" step="25" /><span class="field-unit">ml</span></div>
        </div>
      </fieldset>
    </fieldset>

    <fieldset class="group-box">
      <legend>G2 Companion</legend>
      <section class="hydrate-panel">
        <div id="runtime-card" class="runtime-card runtime-browser">
          <div class="runtime-copy">
            <div class="runtime-title">Even Hub Glasses App</div>
            <div id="runtime-detail" class="runtime-detail">Waiting for Even Hub bridge and device information.</div>
          </div>
          <div id="runtime-badge" class="runtime-badge">Hub</div>
        </div>

        <div class="panel-header">
          <div>
            <div class="eyebrow">G2 Web App</div>
            <h1 class="panel-title">Hydrate HUD</h1>
          </div>
          <div id="today-label" class="today-label"></div>
        </div>

        <div class="hero-card">
          <div class="hero-ring"><div class="hero-ring-inner"><div id="total-ml" class="hero-total">0</div><div class="hero-unit">ml today</div></div></div>
          <div class="hero-copy">
            <div id="goal-copy" class="goal-copy"></div>
            <div class="progress-bar-wrap"><div id="progress-bar" class="progress-bar-fill"></div></div>
            <div id="progress-copy" class="progress-copy"></div>
            <div id="last-drink" class="muted-copy"></div>
            <div id="hud-status" class="muted-copy"></div>
          </div>
        </div>

        <div class="controls">
          <span id="bridge-status" class="status-chip"></span>
          <span id="device-status" class="status-chip"></span>
          <span id="sync-status" class="status-chip"></span>
        </div>

        <div class="section-title">Quick Add</div>
        <div id="quick-add-grid" class="quick-add-grid"></div>

        <div class="custom-add">
          <div class="mini-field grow-field">
            <label for="custom-amount">Custom</label>
            <input id="custom-amount" type="number" min="1" max="2000" step="25" />
            <span class="field-unit">ml</span>
          </div>
          <button id="custom-add-btn" class="primary-btn" type="button">Add Custom</button>
        </div>

        <div class="controls controls-spread">
          <button id="remove-last-btn" type="button">Undo Last</button>
          <button id="push-hud-btn" type="button">Push HUD</button>
          <button id="exit-btn" type="button">Exit Glasses App</button>
        </div>

        <fieldset class="group-box compact-box collapsible collapsed">
          <legend>Today's Log</legend>
          <div id="log-list" class="log-list"></div>
        </fieldset>

      </section>
    </fieldset>

    <fieldset class="group-box">
      <legend>Account & Auto Sync</legend>
      <div class="controls">
        <button id="sign-in-btn" type="button">Sign In With Google</button>
        <button id="sign-out-btn" type="button">Sign Out</button>
      </div>
      <div id="auth-status" class="muted-copy"></div>
      <p class="hint">Sign into the same Google account as the phone app. Hydration changes sync on open and then poll every 5 seconds.</p>
    </fieldset>

    <fieldset id="debug-tools" class="group-box" ${HIDE_DEBUG_TOOLS ? 'style="display:none;"' : ''}>
      <legend>Debug Tools</legend>
      <div class="controls">
        <button id="publish-btn" type="button">Publish App</button>
        <button id="ehpk-btn" type="button">Build EHPK</button>
        <button id="refresh-device-btn" type="button">Refresh Device Info</button>
        <button id="clear-log-btn" type="button">Clear Event Log</button>
        <span id="publish-status"></span>
      </div>
      <p class="hint">Debug tools shortcut: ${DEV_TOOLS_TOGGLE_SHORTCUT}. Double click exits the glasses app.</p>
      <pre id="event-log" class="event-log"></pre>
      <pre id="publish-log" class="publish-log"></pre>
      <fieldset class="group-box compact-box">
        <legend>HUD Preview</legend>
        <div class="sim-display">
          <pre id="hud-preview" class="hud-preview hud-preview-main"></pre>
        </div>
        <div class="hint">This mirrors the text summary pushed into the glasses HUD container.</div>
      </fieldset>
    </fieldset>
  </main>
`;

const runtimeCard = document.querySelector<HTMLDivElement>('#runtime-card')!;
const runtimeDetail = document.querySelector<HTMLDivElement>('#runtime-detail')!;
const runtimeBadge = document.querySelector<HTMLDivElement>('#runtime-badge')!;
const totalMlValue = document.querySelector<HTMLDivElement>('#total-ml')!;
const goalCopy = document.querySelector<HTMLDivElement>('#goal-copy')!;
const progressBar = document.querySelector<HTMLDivElement>('#progress-bar')!;
const progressCopy = document.querySelector<HTMLDivElement>('#progress-copy')!;
const todayLabel = document.querySelector<HTMLDivElement>('#today-label')!;
const lastDrinkLabel = document.querySelector<HTMLDivElement>('#last-drink')!;
const hudStatusLabel = document.querySelector<HTMLDivElement>('#hud-status')!;
const bridgeStatusLabel = document.querySelector<HTMLSpanElement>('#bridge-status')!;
const deviceStatusLabel = document.querySelector<HTMLSpanElement>('#device-status')!;
const syncStatusLabel = document.querySelector<HTMLSpanElement>('#sync-status')!;
const authStatusLabel = document.querySelector<HTMLDivElement>('#auth-status')!;
const quickAddGrid = document.querySelector<HTMLDivElement>('#quick-add-grid')!;
const logList = document.querySelector<HTMLDivElement>('#log-list')!;
const hudPreview = document.querySelector<HTMLPreElement>('#hud-preview')!;
const customAmountInput = document.querySelector<HTMLInputElement>('#custom-amount')!;
const customAddBtn = document.querySelector<HTMLButtonElement>('#custom-add-btn')!;
const removeLastBtn = document.querySelector<HTMLButtonElement>('#remove-last-btn')!;
const pushHudBtn = document.querySelector<HTMLButtonElement>('#push-hud-btn')!;
const exitBtn = document.querySelector<HTMLButtonElement>('#exit-btn')!;
const signInBtn = document.querySelector<HTMLButtonElement>('#sign-in-btn')!;
const signOutBtn = document.querySelector<HTMLButtonElement>('#sign-out-btn')!;
const publishBtn = document.querySelector<HTMLButtonElement>('#publish-btn')!;
const ehpkBtn = document.querySelector<HTMLButtonElement>('#ehpk-btn')!;
const publishStatusLabel = document.querySelector<HTMLSpanElement>('#publish-status')!;
const dailyGoalInput = document.querySelector<HTMLInputElement>('#daily-goal')!;
const reminderIntervalInput = document.querySelector<HTMLInputElement>('#reminder-interval')!;
const reminderEnabledInput = document.querySelector<HTMLInputElement>('#reminder-enabled')!;
const quickAmountInputs = [
  document.querySelector<HTMLInputElement>('#quick-amount-1')!,
  document.querySelector<HTMLInputElement>('#quick-amount-2')!,
  document.querySelector<HTMLInputElement>('#quick-amount-3')!,
  document.querySelector<HTMLInputElement>('#quick-amount-4')!,
];
const refreshDeviceBtn = document.querySelector<HTMLButtonElement>('#refresh-device-btn')!;
const clearLogBtn = document.querySelector<HTMLButtonElement>('#clear-log-btn')!;
const eventLog = document.querySelector<HTMLPreElement>('#event-log')!;
const publishLog = document.querySelector<HTMLPreElement>('#publish-log')!;
const debugToolsFieldset = document.querySelector<HTMLElement>('#debug-tools')!;

hudPreview.style.left = `${(MAIN_PANEL_X / DISPLAY_WIDTH) * 100}%`;
hudPreview.style.width = `${(MAIN_PANEL_WIDTH / DISPLAY_WIDTH) * 100}%`;

function appendEventLog(line: string): void {
  recentEventLines = [...recentEventLines.slice(-18), `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ${line}`];
  eventLog.textContent = recentEventLines.join('\n');
}

const pad = (text: string) => text.slice(0, DISPLAY_COLUMNS).padEnd(DISPLAY_COLUMNS, ' ');
const selectedQuickAmount = () => state.quickAmounts[state.selectedQuickIndex] ?? state.quickAmounts[0] ?? 250;
const clampAppName = (value: string) => String(value || '').trim().slice(0, MAX_APP_NAME_LENGTH);

function buildProgressBar(width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((progressPercent(state) / 100) * width)));
  return `${'■'.repeat(filled)}${'□'.repeat(width - filled)}`;
}

function buildMainHudText(): string {
  const currentAmount = selectedQuickAmount();
  const nextUp = state.quickAmounts[findNextQuickAmountIndex(state, 1)] ?? currentAmount;
  const nextDown = state.quickAmounts[findNextQuickAmountIndex(state, -1)] ?? currentAmount;

  return [
    pad(`HYDRATE - ${state.totalMl} / ${state.dailyGoalMl} ML - ${buildProgressBar()}  ${progressPercent(state)}%`),
    pad(''),
    pad(''),
    pad(''),
    pad(''),
    pad(`CLK: Log ${currentAmount} ML`),
    pad(`UP: ${nextUp} ML`),
    pad(`DWN: ${nextDown} ML`),
    pad('DBL: Exit'),
  ].join('\n');
}

function applyRemoteStateIfNewer(remoteState: HydrateState, sourceLabel: string): boolean {
  const remoteTime = Date.parse(remoteState.lastModifiedAt || '');
  const localTime = Date.parse(state.lastModifiedAt || '');
  if (Number.isFinite(remoteTime) && Number.isFinite(localTime) && remoteTime <= localTime) {
    return false;
  }
  Object.assign(state, remoteState);
  saveHydrateState(state);
  syncStatus = `Pulled latest changes from ${sourceLabel}`;
  return true;
}

async function pushHudToGlasses(reason: string): Promise<void> {
  if (!bridge || pushInFlight) return;

  pushInFlight = true;
  try {
    const mainContent = buildMainHudText();
    const startupContainer = new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({
        xPosition: MAIN_PANEL_X,
        yPosition: 0,
        width: MAIN_PANEL_WIDTH,
        height: 288,
        containerID: MAIN_CONTAINER_ID,
        containerName: MAIN_CONTAINER_NAME,
        content: mainContent,
        isEventCapture: 1,
      })],
    });

    if (!startupCreated) {
      const created = await bridge.createStartUpPageContainer(startupContainer);
      if (created === 0) {
        startupCreated = true;
        hudStatus = `HUD live on glasses (${reason})`;
        appendEventLog(`createStartUpPageContainer ok: ${reason}`);
      } else {
        const rebuilt = await bridge.rebuildPageContainer(new RebuildPageContainer(startupContainer));
        startupCreated = rebuilt;
        hudStatus = rebuilt ? `HUD rebuilt on glasses (${reason})` : `HUD push failed (${created})`;
        appendEventLog(rebuilt ? `rebuildPageContainer ok: ${reason}` : `HUD push failed with code ${created}`);
      }
    } else {
      const upgraded = await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: MAIN_CONTAINER_ID,
        containerName: MAIN_CONTAINER_NAME,
        contentOffset: 0,
        contentLength: mainContent.length,
        content: mainContent,
      }));
      hudStatus = upgraded ? `HUD refreshed on glasses (${reason})` : 'HUD refresh failed';
      appendEventLog(upgraded ? `textContainerUpgrade ok: ${reason}` : 'textContainerUpgrade returned false');
    }
  } catch (error) {
    hudStatus = `HUD error: ${String(error)}`;
    appendEventLog(`HUD error: ${String(error)}`);
  } finally {
    pushInFlight = false;
    await render();
  }
}

async function flushCloudPush(): Promise<void> {
  if (!currentUser || cloudPushRunning || !cloudPushQueued) return;
  cloudPushRunning = true;
  cloudPushQueued = false;
  try {
    await pushRemoteState(currentUser.uid, state, 'glasses');
    syncStatus = `Synced at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  } catch (error) {
    syncStatus = `Cloud push failed: ${String(error)}`;
    cloudPushQueued = true;
  } finally {
    cloudPushRunning = false;
    await render();
  }
}

function queueCloudPush(reason: string): void {
  if (!currentUser) {
    syncStatus = `${reason}. Sign in to sync`;
    void render();
    return;
  }
  cloudPushQueued = true;
  syncStatus = `${reason}. Sync queued`;
  void flushCloudPush();
}

async function syncHud(reason: string): Promise<void> {
  saveHydrateState(state);
  queueCloudPush(reason);
  await render();
  await pushHudToGlasses(reason);
}

async function pullRemoteState(reason: 'startup' | 'poll'): Promise<void> {
  if (!currentUser) return;
  try {
    const remote = await fetchRemoteState(currentUser.uid);
    if (!remote) {
      if (reason === 'startup') {
        syncStatus = 'Signed in. Waiting for first synced change';
      }
      await render();
      return;
    }
    lastRemoteSeenAt = remote.clientUpdatedAt;
    if (applyRemoteStateIfNewer(remote.state, remote.source)) {
      await pushHudToGlasses('cloud sync');
    }
  } catch (error) {
    syncStatus = `Cloud fetch failed: ${String(error)}`;
  }
  await render();
}

function stopCloudSync(): void {
  syncUnsubscribe?.();
  syncUnsubscribe = null;
  if (syncPollTimer !== null) {
    window.clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
}

async function startCloudSync(): Promise<void> {
  stopCloudSync();
  if (!currentUser) {
    syncStatus = 'Sign in to sync with phone';
    await render();
    return;
  }

  await pullRemoteState('startup');

  syncUnsubscribe = subscribeToRemoteState(currentUser.uid, (remote) => {
    if (!remote || remote.clientUpdatedAt === lastRemoteSeenAt) return;
    lastRemoteSeenAt = remote.clientUpdatedAt;
    if (applyRemoteStateIfNewer(remote.state, remote.source)) {
      void pushHudToGlasses('cloud listener').then(render);
    }
  });

  syncPollTimer = window.setInterval(() => {
    void pullRemoteState('poll');
  }, 5000);

  if (state.lastModifiedAt && Date.parse(state.lastModifiedAt) > Date.parse(lastRemoteSeenAt || '1970-01-01T00:00:00.000Z')) {
    queueCloudPush('Local glasses state is newer');
  }
}

async function refreshDeviceInfo(): Promise<void> {
  if (!bridge) return;
  try {
    const device = await bridge.getDeviceInfo();
    if (!device) {
      deviceStatus = 'No connected Even device found';
      appendEventLog('getDeviceInfo returned null');
    } else {
      const status = device.status?.connectType ?? DeviceConnectType.None;
      deviceStatus = `${device.model.toUpperCase()} ${status}`;
      appendEventLog(`Device ${device.model} ${status} ${device.sn}`);
    }
  } catch (error) {
    deviceStatus = `Device query failed: ${String(error)}`;
    appendEventLog(`Device query failed: ${String(error)}`);
  }
  await render();
}

async function exitGlassesApp(): Promise<void> {
  if (!bridge) return;
  try {
    const closed = await bridge.shutDownPageContainer(0);
    appendEventLog(closed ? 'Glasses app exited' : 'Glasses app exit returned false');
  } catch (error) {
    appendEventLog(`Exit failed: ${String(error)}`);
  }
}

function mapEventTypeToAction(eventType: unknown): InputAction | null {
  if (eventType === undefined || eventType === null) return null;
  const normalized = OsEventTypeList.fromJson?.(eventType);
  if (normalized === OsEventTypeList.CLICK_EVENT || eventType === OsEventTypeList.CLICK_EVENT || eventType === 0) return 'CLICK';
  if (normalized === OsEventTypeList.SCROLL_TOP_EVENT || eventType === OsEventTypeList.SCROLL_TOP_EVENT || eventType === 1) return 'UP';
  if (normalized === OsEventTypeList.SCROLL_BOTTOM_EVENT || eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT || eventType === 2) return 'DOWN';
  if (normalized === OsEventTypeList.DOUBLE_CLICK_EVENT || eventType === OsEventTypeList.DOUBLE_CLICK_EVENT || eventType === 3) return 'DOUBLE_CLICK';
  const text = String(eventType).toUpperCase();
  if (text.includes('DOUBLE') && (text.includes('CLICK') || text.includes('TAP'))) return 'DOUBLE_CLICK';
  if (text.includes('SCROLL_TOP') || text === 'UP' || text.includes('SWIPE_UP')) return 'UP';
  if (text.includes('SCROLL_BOTTOM') || text === 'DOWN' || text.includes('SWIPE_DOWN')) return 'DOWN';
  if ((text.includes('SINGLE') && (text.includes('CLICK') || text.includes('TAP'))) || text === 'CLICK' || text === 'TAP' || text.includes('CLICK_EVENT')) return 'CLICK';
  return null;
}

function extractEventType(event: any): unknown {
  return event?.listEvent?.eventType
    ?? event?.textEvent?.eventType
    ?? event?.sysEvent?.eventType
    ?? event?.listEvent?.eventName
    ?? event?.textEvent?.eventName
    ?? event?.sysEvent?.eventName
    ?? event?.listEvent?.type
    ?? event?.textEvent?.type
    ?? event?.sysEvent?.type
    ?? event?.eventType
    ?? event?.type
    ?? event?.name;
}

function shouldTreatEmptySysEventAsClick(event: any): boolean {
  const explicitType = extractEventType(event);
  if (mapEventTypeToAction(explicitType)) return false;
  return !(lastResolvedAction === 'DOUBLE_CLICK' && Date.now() - lastResolvedActionAt < 350);
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
  if (eventLabel === lastEventLabel && signature === lastEventSignature && now - lastEventAt < 140) return true;
  lastEventLabel = eventLabel;
  lastEventSignature = signature;
  lastEventAt = now;
  return false;
}

async function applyAction(action: InputAction): Promise<void> {
  if (action === 'CLICK') {
    addEntry(state, selectedQuickAmount(), `Quick ${state.selectedQuickIndex + 1}`);
    touchState(state);
    syncStatus = `Added ${selectedQuickAmount()} ml from glasses`;
    await syncHud(`HUD click add ${selectedQuickAmount()} ml`);
    return;
  }
  if (action === 'UP') {
    state.selectedQuickIndex = findNextQuickAmountIndex(state, 1);
    touchState(state);
    saveHydrateState(state);
    syncStatus = `Selected ${selectedQuickAmount()} ml`;
    await syncHud(`Selected ${selectedQuickAmount()} ml`);
    return;
  }
  if (action === 'DOWN') {
    state.selectedQuickIndex = findNextQuickAmountIndex(state, -1);
    touchState(state);
    saveHydrateState(state);
    syncStatus = `Selected ${selectedQuickAmount()} ml`;
    await syncHud(`Selected ${selectedQuickAmount()} ml`);
    return;
  }
  await exitGlassesApp();
}

async function render(): Promise<void> {
  totalMlValue.textContent = String(state.totalMl);
  goalCopy.textContent = `Goal ${state.dailyGoalMl} ml`;
  progressBar.style.width = `${progressPercent(state)}%`;
  progressCopy.textContent = `${progressPercent(state)}% complete`;
  todayLabel.textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  lastDrinkLabel.textContent = state.lastDrinkTime;
  hudStatusLabel.textContent = hudStatus;
  bridgeStatusLabel.textContent = bridgeStatus;
  deviceStatusLabel.textContent = deviceStatus;
  syncStatusLabel.textContent = syncStatus;
  authStatusLabel.textContent = authStatus;
  runtimeDetail.textContent = `Launch source: ${launchSourceLabel}. ${bridge ? 'Bridge ready for HUD updates.' : 'Running in browser preview mode.'}`;
  runtimeCard.className = `runtime-card ${bridge ? 'runtime-even-hub' : 'runtime-browser'}`;
  runtimeBadge.textContent = bridge ? 'HUD Live' : 'Preview';
  signInBtn.textContent = currentUser ? 'Signed In' : 'Sign In With Google';
  signInBtn.disabled = !!currentUser || !isCloudSyncConfigured();
  signOutBtn.disabled = !currentUser;
  publishStatusLabel.textContent = publishState;
  publishBtn.textContent = deployed ? 'Update App' : 'Publish App';
  dailyGoalInput.value = String(state.dailyGoalMl);
  reminderIntervalInput.value = String(state.reminderIntervalMinutes);
  reminderEnabledInput.checked = state.reminderEnabled;
  customAmountInput.value = String(state.customAmountMl);
  quickAmountInputs.forEach((input, index) => { input.value = String(state.quickAmounts[index]); });
  hudPreview.textContent = buildMainHudText();
  debugToolsFieldset.style.display = debugVisible ? '' : 'none';
  renderQuickAddButtons();
  renderLog();
}

function renderLog(): void {
  if (state.entries.length === 0) {
    logList.innerHTML = '<div class="empty-state">No entries yet. Add water from the glasses or phone app and it will sync automatically.</div>';
    return;
  }

  logList.innerHTML = '';
  [...state.entries].reverse().forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'log-item';
    row.innerHTML = `
      <span class="log-line">
        <span class="log-amount">${entry.ml} ml</span>
        <span class="log-meta">${entry.label}</span>
        <span class="log-time">${entry.time}</span>
      </span>
      <button type="button" class="log-delete">Delete</button>
    `;
    row.querySelector('button')?.addEventListener('click', () => {
      removeEntry(state, entry.id);
      touchState(state);
      syncStatus = 'Deleted entry on glasses';
      void syncHud('Deleted one entry');
    });
    logList.appendChild(row);
  });
}

function renderQuickAddButtons(): void {
  quickAddGrid.innerHTML = '';
  state.quickAmounts.forEach((amount, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `quick-add-btn${index === state.selectedQuickIndex ? ' selected' : ''}`;
    button.innerHTML = `<span class="quick-amount">${amount}</span><span class="quick-unit">ml</span>`;
    button.addEventListener('click', () => {
      state.selectedQuickIndex = index;
      addEntry(state, amount, `Quick ${index + 1}`);
      touchState(state);
      syncStatus = `Added ${amount} ml on glasses`;
      void syncHud(`Added ${amount} ml from web UI`);
    });
    quickAddGrid.appendChild(button);
  });
}

function bindSettings(): void {
  dailyGoalInput.addEventListener('change', () => {
    state.dailyGoalMl = clampInt(Number(dailyGoalInput.value), 500, 6000);
    touchState(state);
    syncStatus = 'Goal updated on glasses';
    void syncHud('Goal updated');
  });

  reminderIntervalInput.addEventListener('change', () => {
    state.reminderIntervalMinutes = clampInt(Number(reminderIntervalInput.value), 1, 240);
    touchState(state);
    syncStatus = 'Reminder interval updated on glasses';
    void syncHud('Reminder interval updated');
  });

  reminderEnabledInput.addEventListener('change', () => {
    state.reminderEnabled = reminderEnabledInput.checked;
    touchState(state);
    syncStatus = 'Reminder toggle updated on glasses';
    void syncHud('Reminder toggle updated');
  });

  quickAmountInputs.forEach((input, index) => input.addEventListener('change', () => {
    state.quickAmounts[index] = clampInt(Number(input.value), 50, 2000);
    touchState(state);
    syncStatus = 'Quick add presets updated on glasses';
    void syncHud('Quick add presets updated');
  }));

  customAmountInput.addEventListener('change', () => {
    state.customAmountMl = clampInt(Number(customAmountInput.value), 1, 2000);
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Custom amount updated on glasses');
  });
}

function initCollapsibles(): void {
  document.querySelectorAll<HTMLElement>('.collapsible > legend').forEach((legend) => {
    legend.addEventListener('click', () => legend.parentElement?.classList.toggle('collapsed'));
  });
}

function setKeyboardFallback(): void {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      debugVisible = !debugVisible;
      void render();
      return;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      customAddBtn.click();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      void applyAction('UP');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      void applyAction('DOWN');
      return;
    }
  });

  window.addEventListener('dblclick', () => {
    void exitGlassesApp();
  });
}

async function connectBridge(): Promise<void> {
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Even bridge timeout')), BRIDGE_TIMEOUT_MS)),
    ]);
    bridgeStatus = 'Even Hub bridge ready';
    appendEventLog('Bridge ready');

    bridge.onLaunchSource?.((source) => {
      launchSourceLabel = source;
      appendEventLog(`Launch source ${source}`);
      void render();
    });

    bridge.onDeviceStatusChanged?.((status) => {
      deviceStatus = `Glasses ${status.connectType}${typeof status.batteryLevel === 'number' ? ` ${status.batteryLevel}%` : ''}`;
      appendEventLog(`Device status ${status.connectType}`);
      void render();
    });

    bridge.onEvenHubEvent?.((event) => {
      const eventType = extractEventType(event);
      let action = mapEventTypeToAction(eventType);
      if (!action && event?.textEvent && !event?.listEvent && !event?.sysEvent) action = 'CLICK';
      if (!action && shouldTreatEmptySysEventAsClick(event)) action = 'CLICK';
      const eventLabel = action ?? 'NONE';
      if (isDuplicateEvent(event, eventLabel)) return;
      appendEventLog(`${new Date().toLocaleTimeString()}  ${eventLabel}`);
      if (!action) return;
      lastResolvedAction = action;
      lastResolvedActionAt = Date.now();
      void applyAction(action);
    });

    await refreshDeviceInfo();
    await pushHudToGlasses('startup');
  } catch (error) {
    bridgeStatus = `Bridge unavailable: ${String(error)}`;
    hudStatus = 'Browser preview only';
    appendEventLog(`Bridge unavailable: ${String(error)}`);
    await render();
  }
}

async function publishApp(): Promise<void> {
  if (publishState === 'RUNNING') {
    publishLog.textContent = 'Publish is already running. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = await configResponse?.json().catch(() => null) as { config?: { appName?: string; github?: { repo?: string } } } | null;
  const savedRepoName = (configBody?.config?.github?.repo ?? '').trim();
  const defaultAppName = clampAppName(savedRepoName || configBody?.config?.appName || 'hydrate');
  let appName = defaultAppName;

  if (!savedRepoName) {
    const input = window.prompt(`App name (max ${MAX_APP_NAME_LENGTH} chars):`, defaultAppName);
    appName = clampAppName(input ?? '');
    if (!appName) {
      publishLog.textContent = 'Publish cancelled: app name is required.';
      await render();
      return;
    }
  }

  publishState = 'RUNNING';
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
    let body = await response.json().catch(() => null) as { error?: string; logs?: string; code?: string; publishUrl?: string } | null;

    if (!response.ok && (body?.code === 'PAT_REQUIRED' || body?.code === 'INVALID_PAT')) {
      const pat = window.prompt(body?.code === 'INVALID_PAT' ? 'Saved PAT is invalid. Paste a new GitHub PAT:' : 'GitHub PAT required. Paste PAT:');
      if (!pat || !pat.trim()) throw new Error('Publish cancelled: PAT is required.');
      response = await fetch(`${CONTROL_URL}/publish-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName, pat: pat.trim() }),
      });
      body = await response.json().catch(() => null) as { error?: string; logs?: string; publishUrl?: string } | null;
    }

    if (!response.ok) {
      if (response.status === 409) {
        publishState = 'RUNNING';
        publishLog.textContent = 'Publish already running. Please wait for it to complete.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    publishState = 'DONE';
    deployed = true;
    publishLog.textContent = `${body?.logs ?? 'Publish complete.'}\n\nPublished URL:\n${body?.publishUrl ?? 'unknown'}`;
  } catch (error) {
    publishState = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    ehpkBtn.disabled = false;
    await render();
  }
}

async function buildEhpk(): Promise<void> {
  if (publishState === 'RUNNING' || publishState === 'PACKING') {
    publishLog.textContent = 'Another operation is in progress. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = await configResponse?.json().catch(() => null) as { config?: { appName?: string } } | null;
  const defaultAppName = clampAppName((configBody?.config?.appName ?? 'hydrate').trim() || 'hydrate');
  const input = window.prompt(`App name for .ehpk package (max ${MAX_APP_NAME_LENGTH} chars):`, defaultAppName);
  const appName = clampAppName(input ?? '');
  if (!appName) {
    publishLog.textContent = 'Build cancelled: app name is required.';
    await render();
    return;
  }

  publishState = 'PACKING';
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
    const body = await response.json().catch(() => null) as { error?: string; logs?: string; outputPath?: string } | null;
    if (!response.ok) {
      if (response.status === 409) {
        publishState = 'PACKING';
        publishLog.textContent = 'EHPK build already running. Please wait for it to finish.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    publishState = 'DONE';
    publishLog.textContent = `${body?.logs ?? 'EHPK build complete.'}\n\nOutput:\n${body?.outputPath ?? 'unknown'}`;
  } catch (error) {
    publishState = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    ehpkBtn.disabled = false;
    await render();
  }
}

async function init(): Promise<void> {
  initCollapsibles();
  bindSettings();
  setKeyboardFallback();

  customAddBtn.addEventListener('click', () => {
    state.customAmountMl = clampInt(Number(customAmountInput.value), 1, 2000);
    addEntry(state, state.customAmountMl, 'Custom');
    touchState(state);
    syncStatus = `Added ${state.customAmountMl} ml on glasses`;
    void syncHud(`Custom add ${state.customAmountMl} ml`);
  });

  removeLastBtn.addEventListener('click', () => {
    undoEntry(state);
    touchState(state);
    syncStatus = 'Removed last entry on glasses';
    void syncHud('Undo last');
  });

  pushHudBtn.addEventListener('click', () => {
    syncStatus = 'Manual HUD push requested';
    void pushHudToGlasses('manual push');
  });

  exitBtn.addEventListener('click', () => {
    void exitGlassesApp();
  });

  signInBtn.addEventListener('click', () => {
    void signInWithGoogle().catch((error) => {
      authStatus = `Google sign-in failed: ${String(error)}`;
      void render();
    });
  });

  signOutBtn.addEventListener('click', () => {
    void signOutFromCloud().catch((error) => {
      authStatus = `Sign out failed: ${String(error)}`;
      void render();
    });
  });

  refreshDeviceBtn.addEventListener('click', () => {
    void refreshDeviceInfo();
  });

  clearLogBtn.addEventListener('click', () => {
    recentEventLines = ['Event log cleared'];
    eventLog.textContent = recentEventLines.join('\n');
  });
  publishBtn.addEventListener('click', () => {
    void publishApp();
  });
  ehpkBtn.addEventListener('click', () => {
    void buildEhpk();
  });

  const bootstrap = await bootstrapCloudSync();
  if (!bootstrap.configured) {
    authStatus = 'Firebase env vars are missing';
    syncStatus = 'Auto sync disabled until Firebase is configured';
  } else {
    currentUser = bootstrap.user;
    authStatus = currentUser?.email || currentUser?.displayName || 'Ready to sign in';
    listenForUserChange((user) => {
      currentUser = user;
      authStatus = user?.email || user?.displayName || 'Signed out';
      void startCloudSync();
      void render();
    });
  }

  try {
    const health = await fetch(`${CONTROL_URL}/health`, { cache: 'no-store' });
    const info = await health.json().catch(() => null) as { capabilities?: string[]; version?: string } | null;
    publishLog.textContent = !health.ok || !info?.capabilities?.includes(REQUIRED_CONTROL_CAPABILITY)
      ? 'Control server is outdated. Run Run-Even-Sim.cmd to refresh local services.'
      : `Control server ready (${info.version ?? 'unknown'})`;
  } catch {
    publishLog.textContent = 'Control server not reachable. Run Run-Even-Sim.cmd.';
  }

  try {
    const response = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' });
    const body = await response.json().catch(() => null) as { config?: { git?: { deployed?: boolean } } } | null;
    deployed = !!body?.config?.git?.deployed;
  } catch {}

  await render();
  await connectBridge();
  if (currentUser) {
    await startCloudSync();
  }
}

void init();
