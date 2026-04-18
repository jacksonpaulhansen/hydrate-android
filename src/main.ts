import './style.css';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
// import type { User } from 'firebase/auth';  // BLE: firebase not used
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
/* BLE: cloud-sync commented out — replaced by ble-sync
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
*/
import { startPhoneBleServer, type PhoneBleSyncHandle } from './ble-sync';

const HIDE_DEBUG_TOOLS = true;
const DEV_TOOLS_TOGGLE_SHORTCUT = 'Ctrl+Shift+D';
const NOTIFICATION_ID = 4242;
const NOTIFICATION_CHANNEL_ID = 'hydrate-reminders';

const isAndroidApp = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
const state: HydrateState = loadHydrateState();

let debugToolsVisible = !HIDE_DEBUG_TOOLS;
let reminderTimer: number | null = null;
let syncStatus = 'BLE sync — tap "Start BLE Server" to begin';
let debugStatus = 'Ready';
/* BLE: firebase auth state variables commented out
let authStatus = isCloudSyncConfigured() ? 'Checking sign-in...' : 'Firebase config missing';
let currentUser: User | null = null;
let syncUnsubscribe: (() => void) | null = null;
let syncPollTimer: number | null = null;
let lastRemoteSeenAt = '';
let pushQueued = false;
let pushRunning = false;
*/
let authStatus = 'BLE sync (no sign-in required)';
let bleSyncHandle: PhoneBleSyncHandle | null = null;

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
      <legend>Hydrate Companion</legend>
      <section class="hydrate-panel">
        <div class="runtime-card runtime-android">
          <div class="runtime-copy">
            <div class="runtime-title">Android Companion App</div>
            <div class="runtime-detail">This app owns reminder scheduling and syncs automatically with the G2 web companion app.</div>
          </div>
          <div class="runtime-badge">Android</div>
        </div>

        <div class="panel-header">
          <div>
            <div class="eyebrow">Phone App</div>
            <h1 class="panel-title">Hydrate</h1>
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
          </div>
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
          <button id="reset-day-btn" type="button">Reset Day</button>
          <span id="reminder-status" class="status-chip"></span>
        </div>
        <div id="next-reminder" class="muted-copy"></div>

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
        <span id="sync-status" class="status-chip"></span>
      </div>
      <div id="auth-status" class="muted-copy"></div>
      <p class="hint">Open both apps while signed into the same Google account and they will sync immediately, then poll every 5 seconds for updates.</p>
    </fieldset>

    <fieldset id="debug-tools" class="group-box" ${HIDE_DEBUG_TOOLS ? 'style="display:none;"' : ''}>
      <legend>Debug Tools</legend>
      <div class="controls">
        <button id="request-permission-btn" type="button">Request Notifications</button>
        <button id="test-reminder-btn" type="button">Test Reminder</button>
        <span id="debug-status"></span>
      </div>
      <p class="hint">Debug tools shortcut: ${DEV_TOOLS_TOGGLE_SHORTCUT}</p>
    </fieldset>
  </main>
`;

const totalMlValue = document.querySelector<HTMLDivElement>('#total-ml')!;
const goalCopy = document.querySelector<HTMLDivElement>('#goal-copy')!;
const progressBar = document.querySelector<HTMLDivElement>('#progress-bar')!;
const progressCopy = document.querySelector<HTMLDivElement>('#progress-copy')!;
const todayLabel = document.querySelector<HTMLDivElement>('#today-label')!;
const lastDrinkLabel = document.querySelector<HTMLDivElement>('#last-drink')!;
const quickAddGrid = document.querySelector<HTMLDivElement>('#quick-add-grid')!;
const reminderStatus = document.querySelector<HTMLSpanElement>('#reminder-status')!;
const nextReminderLabel = document.querySelector<HTMLDivElement>('#next-reminder')!;
const logList = document.querySelector<HTMLDivElement>('#log-list')!;
const customAmountInput = document.querySelector<HTMLInputElement>('#custom-amount')!;
const customAddBtn = document.querySelector<HTMLButtonElement>('#custom-add-btn')!;
const removeLastBtn = document.querySelector<HTMLButtonElement>('#remove-last-btn')!;
const resetDayBtn = document.querySelector<HTMLButtonElement>('#reset-day-btn')!;
const dailyGoalInput = document.querySelector<HTMLInputElement>('#daily-goal')!;
const reminderIntervalInput = document.querySelector<HTMLInputElement>('#reminder-interval')!;
const reminderEnabledInput = document.querySelector<HTMLInputElement>('#reminder-enabled')!;
const quickAmountInputs = [
  document.querySelector<HTMLInputElement>('#quick-amount-1')!,
  document.querySelector<HTMLInputElement>('#quick-amount-2')!,
  document.querySelector<HTMLInputElement>('#quick-amount-3')!,
  document.querySelector<HTMLInputElement>('#quick-amount-4')!,
];
const signInBtn = document.querySelector<HTMLButtonElement>('#sign-in-btn')!;
const signOutBtn = document.querySelector<HTMLButtonElement>('#sign-out-btn')!;
const syncStatusLabel = document.querySelector<HTMLSpanElement>('#sync-status')!;
const authStatusLabel = document.querySelector<HTMLDivElement>('#auth-status')!;
const debugStatusLabel = document.querySelector<HTMLSpanElement>('#debug-status')!;
const requestPermissionBtn = document.querySelector<HTMLButtonElement>('#request-permission-btn')!;
const testReminderBtn = document.querySelector<HTMLButtonElement>('#test-reminder-btn')!;
const debugToolsFieldset = document.querySelector<HTMLElement>('#debug-tools')!;

function formatReminderTime(timestamp: number | null): string {
  if (!timestamp) return 'Next reminder: off';
  return `Next reminder: ${new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/* BLE: cloud sync functions commented out — replaced by BLE equivalents below
function applyRemoteStateIfNewer(remoteState: HydrateState, sourceLabel: string): boolean { ... }
async function flushCloudPush(): Promise<void> { ... }
function queueCloudPush(reason: string): void { ... }
async function pullRemoteState(reason: 'startup' | 'poll'): Promise<void> { ... }
function stopCloudSync(): void { ... }
async function startCloudSync(): Promise<void> { ... }
*/

// BLE: called whenever local state changes; pushes to glasses via GATT notify
function queueCloudPush(reason: string): void {
  syncStatus = reason;
  if (bleSyncHandle) {
    void bleSyncHandle.pushState(state)
      .then(() => {
        syncStatus = `BLE synced — ${reason}`;
        return render();
      })
      .catch((error: unknown) => {
        syncStatus = `BLE push failed: ${String(error)}`;
        return render();
      });
  }
  void render();
}

function renderLog(): void {
  if (state.entries.length === 0) {
    logList.innerHTML = '<div class="empty-state">No entries yet. Add water from the phone app and it will sync to the glasses app automatically.</div>';
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
      saveHydrateState(state);
      queueCloudPush('Deleted entry on phone');
      void scheduleReminder().then(render);
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
      saveHydrateState(state);
      queueCloudPush(`Added ${amount} ml on phone`);
      void scheduleReminder().then(render);
    });
    quickAddGrid.appendChild(button);
  });
}

async function ensureNotificationPermission(requestIfNeeded: boolean): Promise<boolean> {
  if (isAndroidApp) {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return true;
    if (!requestIfNeeded) return false;

    const requested = await LocalNotifications.requestPermissions();
    if (requested.display !== 'granted') return false;

    await LocalNotifications.createChannel({
      id: NOTIFICATION_CHANNEL_ID,
      name: 'Hydrate Reminders',
      description: 'Hydration reminders from the Android companion app',
      importance: 4,
      vibration: true,
    });
    return true;
  }

  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (!requestIfNeeded) return false;

  return (await Notification.requestPermission()) === 'granted';
}

async function cancelScheduledReminder(): Promise<void> {
  if (isAndroidApp) {
    await LocalNotifications.cancel({ notifications: [{ id: NOTIFICATION_ID }] });
    return;
  }
  if (reminderTimer !== null) {
    window.clearTimeout(reminderTimer);
    reminderTimer = null;
  }
}

async function scheduleReminder(): Promise<void> {
  await cancelScheduledReminder();
  if (!state.reminderEnabled) return;

  const allowed = await ensureNotificationPermission(false);
  if (!allowed) {
    debugStatus = 'Need notification permission';
    return;
  }

  const nextReminderAt = Date.now() + state.reminderIntervalMinutes * 60 * 1000;
  if (isAndroidApp) {
    await LocalNotifications.schedule({
      notifications: [{
        id: NOTIFICATION_ID,
        title: 'Hydrate',
        body: `Time to drink water. You are at ${state.totalMl} of ${state.dailyGoalMl} ml.`,
        channelId: NOTIFICATION_CHANNEL_ID,
        schedule: { at: new Date(nextReminderAt), allowWhileIdle: true },
      }],
    });
    return;
  }

  reminderTimer = window.setTimeout(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      void new Notification('Hydrate', { body: `Time to drink water. You are at ${state.totalMl} of ${state.dailyGoalMl} ml.` });
    }
    void scheduleReminder().then(render);
  }, state.reminderIntervalMinutes * 60 * 1000);
}

async function sendTestReminder(): Promise<void> {
  const allowed = await ensureNotificationPermission(true);
  if (!allowed) {
    debugStatus = 'Notifications denied';
    await render();
    return;
  }

  if (isAndroidApp) {
    await LocalNotifications.schedule({
      notifications: [{
        id: NOTIFICATION_ID + 1,
        title: 'Hydrate',
        body: 'Test reminder from the Android companion app.',
        channelId: NOTIFICATION_CHANNEL_ID,
        schedule: { at: new Date(Date.now() + 1500), allowWhileIdle: true },
      }],
    });
  } else {
    void new Notification('Hydrate', { body: 'Test reminder from the Android companion app.' });
  }

  debugStatus = 'Test reminder sent';
  await render();
}

async function render(): Promise<void> {
  totalMlValue.textContent = String(state.totalMl);
  goalCopy.textContent = `Goal ${state.dailyGoalMl} ml`;
  progressBar.style.width = `${progressPercent(state)}%`;
  progressCopy.textContent = `${progressPercent(state)}% complete`;
  todayLabel.textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  lastDrinkLabel.textContent = state.lastDrinkTime;
  reminderStatus.textContent = state.reminderEnabled ? `Reminders ${state.reminderIntervalMinutes}m` : 'Reminders Off';
  nextReminderLabel.textContent = formatReminderTime(state.reminderEnabled ? Date.now() + state.reminderIntervalMinutes * 60 * 1000 : null);
  dailyGoalInput.value = String(state.dailyGoalMl);
  reminderIntervalInput.value = String(state.reminderIntervalMinutes);
  reminderEnabledInput.checked = state.reminderEnabled;
  customAmountInput.value = String(state.customAmountMl);
  quickAmountInputs.forEach((input, index) => { input.value = String(state.quickAmounts[index]); });
  authStatusLabel.textContent = authStatus;
  syncStatusLabel.textContent = syncStatus;
  debugStatusLabel.textContent = debugStatus;
  /* BLE: firebase auth button state commented out
  signInBtn.textContent = currentUser ? 'Signed In' : 'Sign In With Google';
  signInBtn.disabled = !!currentUser || !isCloudSyncConfigured();
  signOutBtn.disabled = !currentUser;
  */
  signInBtn.textContent = bleSyncHandle ? 'BLE Active' : 'Start BLE Server';
  signInBtn.disabled = !!bleSyncHandle;
  signOutBtn.textContent = 'Stop BLE';
  signOutBtn.disabled = !bleSyncHandle;
  debugToolsFieldset.style.display = debugToolsVisible ? '' : 'none';
  renderQuickAddButtons();
  renderLog();
}

function bindSettings(): void {
  dailyGoalInput.addEventListener('change', () => {
    state.dailyGoalMl = clampInt(Number(dailyGoalInput.value), 500, 6000);
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Goal updated on phone');
    void scheduleReminder().then(render);
  });
  reminderIntervalInput.addEventListener('change', () => {
    state.reminderIntervalMinutes = clampInt(Number(reminderIntervalInput.value), 1, 240);
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Reminder interval updated');
    void scheduleReminder().then(render);
  });
  reminderEnabledInput.addEventListener('change', () => {
    state.reminderEnabled = reminderEnabledInput.checked;
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Reminder toggle updated');
    void scheduleReminder().then(render);
  });
  quickAmountInputs.forEach((input, index) => input.addEventListener('change', () => {
    state.quickAmounts[index] = clampInt(Number(input.value), 50, 2000);
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Quick add presets updated');
    void render();
  }));
  customAmountInput.addEventListener('change', () => {
    state.customAmountMl = clampInt(Number(customAmountInput.value), 1, 2000);
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Custom amount updated');
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
      debugToolsVisible = !debugToolsVisible;
      void render();
      return;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Enter') return void customAddBtn.click();
    if (event.key === 'ArrowUp') {
      state.selectedQuickIndex = findNextQuickAmountIndex(state, 1);
      saveHydrateState(state);
      return void render();
    }
    if (event.key === 'ArrowDown') {
      state.selectedQuickIndex = findNextQuickAmountIndex(state, -1);
      saveHydrateState(state);
      return void render();
    }
  });
}

async function initAndroidBehavior(): Promise<void> {
  if (!isAndroidApp) return;
  await CapacitorApp.toggleBackButtonHandler({ enabled: false });
  await CapacitorApp.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void CapacitorApp.minimizeApp();
  });
  await ensureNotificationPermission(false);
}

async function init(): Promise<void> {
  initCollapsibles();
  setKeyboardFallback();
  bindSettings();

  customAddBtn.addEventListener('click', () => {
    state.customAmountMl = clampInt(Number(customAmountInput.value), 1, 2000);
    addEntry(state, state.customAmountMl, 'Custom');
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Added custom entry in phone app');
    void scheduleReminder().then(render);
  });
  removeLastBtn.addEventListener('click', () => {
    undoEntry(state);
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Removed last entry in phone app');
    void scheduleReminder().then(render);
  });
  resetDayBtn.addEventListener('click', () => {
    if (!window.confirm('Reset today\'s hydration log?')) return;
    state.totalMl = 0;
    state.entries = [];
    state.lastDrinkTime = 'No drinks yet';
    touchState(state);
    saveHydrateState(state);
    queueCloudPush('Day reset in phone app');
    void scheduleReminder().then(render);
  });
  /* BLE: Google sign-in handlers commented out
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
  */
  signInBtn.addEventListener('click', () => {
    authStatus = 'Starting BLE server...';
    void render();
    void startPhoneBleServer((remoteState) => {
      const remoteTime = Date.parse(remoteState.lastModifiedAt || '');
      const localTime = Date.parse(state.lastModifiedAt || '');
      if (!Number.isFinite(remoteTime) || (Number.isFinite(localTime) && remoteTime <= localTime)) return;
      Object.assign(state, remoteState);
      saveHydrateState(state);
      syncStatus = 'Pulled state from glasses via BLE';
      void scheduleReminder().then(render);
    }).then((handle) => {
      if (handle) {
        bleSyncHandle = handle;
        authStatus = 'BLE server running — glasses can now connect';
        syncStatus = 'Waiting for glasses to connect';
      } else {
        authStatus = 'BLE not available (HydrateBle plugin missing)';
      }
      void render();
    }).catch((error: unknown) => {
      authStatus = `BLE start failed: ${String(error)}`;
      void render();
    });
  });
  signOutBtn.addEventListener('click', () => {
    void bleSyncHandle?.stop();
    bleSyncHandle = null;
    authStatus = 'BLE server stopped';
    syncStatus = 'BLE sync — tap "Start BLE Server" to begin';
    void render();
  });
  requestPermissionBtn.addEventListener('click', () => {
    void ensureNotificationPermission(true).then((allowed) => {
      debugStatus = allowed ? 'Notifications enabled' : 'Notifications denied';
      return render();
    });
  });
  testReminderBtn.addEventListener('click', () => void sendTestReminder());

  await initAndroidBehavior();

  /* BLE: Firebase bootstrap commented out
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
  if (currentUser) {
    await startCloudSync();
  }
  */

  await scheduleReminder();
  await render();
}

void init();
