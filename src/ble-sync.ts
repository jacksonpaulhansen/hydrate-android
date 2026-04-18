import type { HydrateState } from './hydrate-shared';

export const BLE_SERVICE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
export const BLE_STATE_CHAR_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567891';

// ── Phone side: Capacitor native GATT server (peripheral) ───────────────────
// Served by HydrateBlePlugin.java registered in MainActivity.

type HydrateBlePlugin = {
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
  updateState(options: { state: string }): Promise<void>;
  addListener(
    event: 'bleStateUpdate',
    handler: (data: { state: string }) => void,
  ): Promise<{ remove(): void }>;
  addListener(
    event: 'bleConnected' | 'bleDisconnected',
    handler: (data: { deviceId: string }) => void,
  ): Promise<{ remove(): void }>;
};

function getHydrateBlePlugin(): HydrateBlePlugin | null {
  const plugins = (window as any)?.Capacitor?.Plugins;
  return (plugins?.HydrateBle as HydrateBlePlugin | undefined) ?? null;
}

export type PhoneBleSyncHandle = {
  pushState(state: HydrateState): Promise<void>;
  stop(): Promise<void>;
};

export async function startPhoneBleServer(
  onRemoteUpdate: (state: HydrateState) => void,
): Promise<PhoneBleSyncHandle | null> {
  const plugin = getHydrateBlePlugin();
  if (!plugin) return null;

  try {
    await plugin.startServer();
    await plugin.addListener('bleStateUpdate', ({ state: json }) => {
      try {
        onRemoteUpdate(JSON.parse(json) as HydrateState);
      } catch {}
    });
    return {
      async pushState(state: HydrateState) {
        await plugin.updateState({ state: JSON.stringify(state) });
      },
      async stop() {
        await plugin.stopServer();
      },
    };
  } catch (error) {
    console.warn('BLE server start failed:', error);
    return null;
  }
}

// ── Glasses side: Web Bluetooth central ─────────────────────────────────────
// requestDevice() requires a user gesture — call connectGlassesBle() from a
// button click handler, not automatically on page load.
// Works in Chrome and modern Android WebViews served from HTTPS or localhost.

export type GlassesBleSyncHandle = {
  pushState(state: HydrateState): Promise<void>;
  stop(): void;
};

type WebBleChar = EventTarget & {
  readValue(): Promise<DataView>;
  startNotifications(): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  value?: DataView | null;
};

type WebBleService = {
  getCharacteristic(uuid: string): Promise<WebBleChar>;
};

type WebBleGattServer = {
  connect(): Promise<WebBleGattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<WebBleService>;
};

type WebBleDevice = EventTarget & {
  gatt?: WebBleGattServer | null;
};

type WebBleNavigator = Navigator & {
  bluetooth?: {
    requestDevice(options: { filters: Array<{ services: string[] }> }): Promise<WebBleDevice>;
  };
};

let _glassesGattServer: WebBleGattServer | null = null;
let _glassesChar: WebBleChar | null = null;

export async function connectGlassesBle(
  onRemoteUpdate: (state: HydrateState) => void,
): Promise<GlassesBleSyncHandle | null> {
  const nav = navigator as WebBleNavigator;
  if (!nav.bluetooth) return null;

  try {
    const device = await nav.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
    });

    _glassesGattServer = await device.gatt!.connect();
    const service = await _glassesGattServer.getPrimaryService(BLE_SERVICE_UUID);
    _glassesChar = await service.getCharacteristic(BLE_STATE_CHAR_UUID);

    // Read initial state from phone
    const initValue = await _glassesChar.readValue();
    const initJson = new TextDecoder().decode(initValue);
    if (initJson && initJson !== '{}') {
      try { onRemoteUpdate(JSON.parse(initJson) as HydrateState); } catch {}
    }

    // Subscribe to phone-pushed notifications
    await _glassesChar.startNotifications();
    _glassesChar.addEventListener('characteristicvaluechanged', (event: Event) => {
      const char = event.target as WebBleChar;
      const json = new TextDecoder().decode(char.value!);
      try { onRemoteUpdate(JSON.parse(json) as HydrateState); } catch {}
    });

    device.addEventListener('gattserverdisconnected', () => {
      _glassesGattServer = null;
      _glassesChar = null;
    });

    return {
      async pushState(state: HydrateState) {
        if (!_glassesChar) return;
        await _glassesChar.writeValueWithoutResponse(
          new TextEncoder().encode(JSON.stringify(state)),
        );
      },
      stop() {
        _glassesGattServer?.disconnect();
        _glassesGattServer = null;
        _glassesChar = null;
      },
    };
  } catch (error) {
    console.warn('Web Bluetooth connection failed:', error);
    return null;
  }
}
