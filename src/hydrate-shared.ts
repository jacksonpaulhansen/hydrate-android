export type Entry = { id: string; ml: number; label: string; time: string };
export type DailyState = { date: string; totalMl: number; entries: Entry[] };

export type HydrateSettings = {
  dailyGoalMl: number;
  quickAmounts: number[];
  selectedQuickIndex: number;
  customAmountMl: number;
  reminderEnabled: boolean;
  reminderIntervalMinutes: number;
};

export type HydrateState = HydrateSettings & {
  totalMl: number;
  entries: Entry[];
  lastDrinkTime: string;
  lastModifiedAt: string;
};

export type SyncPayload = {
  generatedAt: string;
  daily: DailyState;
  settings: HydrateSettings;
};

export type HudAction = {
  label: string;
  amount: number | null;
  kind: 'quickAdd' | 'undo' | 'sync';
};

export const STORAGE_KEY = 'hydrate_state_v1';
export const SETTINGS_STORAGE_KEY = 'hydrate_settings_v1';
export const DEFAULT_GOAL_ML = 2500;
export const DEFAULT_QUICK_AMOUNTS = [150, 250, 500, 750];
export const DEFAULT_REMINDER_INTERVAL = 60;

export function createDefaultState(): HydrateState {
  return {
    totalMl: 0,
    dailyGoalMl: DEFAULT_GOAL_ML,
    quickAmounts: [...DEFAULT_QUICK_AMOUNTS],
    selectedQuickIndex: 1,
    customAmountMl: 300,
    reminderEnabled: false,
    reminderIntervalMinutes: DEFAULT_REMINDER_INTERVAL,
    entries: [],
    lastDrinkTime: 'No drinks yet',
    lastModifiedAt: new Date(0).toISOString(),
  };
}

export const clampInt = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? Math.round(value) : min));
export const currentDateKey = () => new Date().toDateString();
export const nowLabel = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const progressPercent = (state: Pick<HydrateState, 'totalMl' | 'dailyGoalMl'>) => Math.min(100, Math.round((state.totalMl / Math.max(1, state.dailyGoalMl)) * 100));

export function selectedQuickAmount(state: Pick<HydrateState, 'quickAmounts' | 'selectedQuickIndex'>): number {
  return state.quickAmounts[state.selectedQuickIndex] ?? state.quickAmounts[0] ?? DEFAULT_QUICK_AMOUNTS[0];
}

export function updateLastDrinkTime(state: HydrateState, entry?: Entry): void {
  state.lastDrinkTime = entry ? `Last drink at ${entry.time}` : 'No drinks yet';
}

export function resetForNewDay(state: HydrateState): void {
  state.totalMl = 0;
  state.entries = [];
  updateLastDrinkTime(state);
}

export function loadHydrateState(): HydrateState {
  const state = createDefaultState();

  try {
    const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (rawSettings) {
      const saved = JSON.parse(rawSettings) as Partial<HydrateSettings>;
      state.dailyGoalMl = clampInt(Number(saved.dailyGoalMl), 500, 6000) || DEFAULT_GOAL_ML;
      if (Array.isArray(saved.quickAmounts) && saved.quickAmounts.length === 4) {
        state.quickAmounts = saved.quickAmounts.map((value) => clampInt(Number(value), 50, 2000));
      }
      state.selectedQuickIndex = clampInt(Number(saved.selectedQuickIndex), 0, 3);
      state.customAmountMl = clampInt(Number(saved.customAmountMl), 1, 2000) || 300;
      state.reminderEnabled = !!saved.reminderEnabled;
      state.reminderIntervalMinutes = clampInt(Number(saved.reminderIntervalMinutes), 1, 240) || DEFAULT_REMINDER_INTERVAL;
      state.lastModifiedAt = typeof (saved as Partial<HydrateState>).lastModifiedAt === 'string'
        ? (saved as Partial<HydrateState>).lastModifiedAt!
        : state.lastModifiedAt;
    }
  } catch {}

  try {
    const rawDaily = localStorage.getItem(STORAGE_KEY);
    if (rawDaily) {
      const saved = JSON.parse(rawDaily) as DailyState;
      if (saved.date === currentDateKey()) {
        state.totalMl = clampInt(Number(saved.totalMl), 0, 100000);
        state.entries = Array.isArray(saved.entries) ? saved.entries : [];
        updateLastDrinkTime(state, state.entries[state.entries.length - 1]);
      }
    }
  } catch {}

  return state;
}

export function saveHydrateState(state: HydrateState): void {
  const settings: HydrateSettings = {
    dailyGoalMl: state.dailyGoalMl,
    quickAmounts: state.quickAmounts,
    selectedQuickIndex: state.selectedQuickIndex,
    customAmountMl: state.customAmountMl,
    reminderEnabled: state.reminderEnabled,
    reminderIntervalMinutes: state.reminderIntervalMinutes,
  };
  const fullSettings = {
    ...settings,
    lastModifiedAt: state.lastModifiedAt,
  };
  const daily: DailyState = {
    date: currentDateKey(),
    totalMl: state.totalMl,
    entries: state.entries,
  };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(fullSettings));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(daily));
}

export function touchState(state: HydrateState): void {
  state.lastModifiedAt = new Date().toISOString();
}

export function addEntry(state: HydrateState, amount: number, label: string): Entry {
  const entry: Entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ml: clampInt(amount, 1, 2000),
    label,
    time: nowLabel(),
  };
  state.totalMl += entry.ml;
  state.entries.push(entry);
  updateLastDrinkTime(state, entry);
  return entry;
}

export function removeEntry(state: HydrateState, entryId: string): void {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;
  state.totalMl = Math.max(0, state.totalMl - entry.ml);
  state.entries = state.entries.filter((item) => item.id !== entryId);
  updateLastDrinkTime(state, state.entries[state.entries.length - 1]);
}

export function undoEntry(state: HydrateState): void {
  const last = state.entries[state.entries.length - 1];
  if (!last) return;
  state.totalMl = Math.max(0, state.totalMl - last.ml);
  state.entries.pop();
  updateLastDrinkTime(state, state.entries[state.entries.length - 1]);
}

export function createSyncPayload(state: HydrateState): string {
  const payload: SyncPayload = {
    generatedAt: new Date().toISOString(),
    daily: {
      date: currentDateKey(),
      totalMl: state.totalMl,
      entries: state.entries,
    },
    settings: {
      dailyGoalMl: state.dailyGoalMl,
      quickAmounts: state.quickAmounts,
      selectedQuickIndex: state.selectedQuickIndex,
      customAmountMl: state.customAmountMl,
      reminderEnabled: state.reminderEnabled,
      reminderIntervalMinutes: state.reminderIntervalMinutes,
    },
  };
  return JSON.stringify(payload, null, 2);
}

export function buildHudSummary(state: HydrateState): string {
  const lines = [
    'HYDRATE',
    `${state.totalMl}/${state.dailyGoalMl} ml`,
    `${progressPercent(state)}% COMPLETE`,
    state.reminderEnabled
      ? `NEXT ${state.reminderIntervalMinutes}M`
      : 'REMINDERS OFF',
    state.lastDrinkTime.replace('Last drink at ', 'LAST '),
  ];
  return lines.join('\n');
}

export function buildQuickActions(state: Pick<HydrateState, 'quickAmounts'>): HudAction[] {
  return [
    ...state.quickAmounts.map((amount) => ({
      label: `+${amount} ml`,
      amount,
      kind: 'quickAdd' as const,
    })),
    { label: 'Undo Last', amount: null, kind: 'undo' as const },
    { label: 'Refresh Sync', amount: null, kind: 'sync' as const },
  ];
}

export function applySyncPayload(state: HydrateState, raw: string): string {
  const payload = JSON.parse(raw) as Partial<SyncPayload>;
  if (!payload.daily || !payload.settings) {
    throw new Error('Sync payload is missing daily or settings data.');
  }

  state.dailyGoalMl = clampInt(Number(payload.settings.dailyGoalMl), 500, 6000) || DEFAULT_GOAL_ML;
  state.quickAmounts = Array.isArray(payload.settings.quickAmounts) && payload.settings.quickAmounts.length === 4
    ? payload.settings.quickAmounts.map((value) => clampInt(Number(value), 50, 2000))
    : [...DEFAULT_QUICK_AMOUNTS];
  state.selectedQuickIndex = clampInt(Number(payload.settings.selectedQuickIndex), 0, 3);
  state.customAmountMl = clampInt(Number(payload.settings.customAmountMl), 1, 2000) || 300;
  state.reminderEnabled = !!payload.settings.reminderEnabled;
  state.reminderIntervalMinutes = clampInt(Number(payload.settings.reminderIntervalMinutes), 1, 240) || DEFAULT_REMINDER_INTERVAL;

  if (payload.daily.date === currentDateKey()) {
    state.totalMl = clampInt(Number(payload.daily.totalMl), 0, 100000);
    state.entries = Array.isArray(payload.daily.entries) ? payload.daily.entries : [];
  } else {
    resetForNewDay(state);
  }

  state.lastModifiedAt = payload.generatedAt ?? new Date().toISOString();
  updateLastDrinkTime(state, state.entries[state.entries.length - 1]);
  return payload.generatedAt ?? 'unknown time';
}

export function findNextQuickAmountIndex(state: Pick<HydrateState, 'quickAmounts' | 'selectedQuickIndex'>, direction: 1 | -1): number {
  const amounts = state.quickAmounts;
  const currentAmount = selectedQuickAmount(state);

  if (amounts.length === 0) return 0;

  const indexed = amounts.map((amount, index) => ({ amount, index }));
  const sorted = [...indexed].sort((a, b) => a.amount - b.amount || a.index - b.index);

  if (direction === 1) {
    const next = sorted.find((item) => item.amount > currentAmount);
    return (next ?? sorted[0]).index;
  }

  const lower = sorted.filter((item) => item.amount < currentAmount);
  return (lower[lower.length - 1] ?? sorted[sorted.length - 1]).index;
}
