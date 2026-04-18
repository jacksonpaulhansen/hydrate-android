package com.hydrate.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
        name = "HydrateBle",
        permissions = {
                @Permission(
                        alias = "ble",
                        strings = {
                                Manifest.permission.BLUETOOTH_CONNECT,
                                Manifest.permission.BLUETOOTH_ADVERTISE
                        }
                )
        }
)
public class HydrateBlePlugin extends Plugin {

    private static final UUID SERVICE_UUID     = UUID.fromString("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    private static final UUID STATE_CHAR_UUID  = UUID.fromString("a1b2c3d4-e5f6-7890-abcd-ef1234567891");
    // Client Characteristic Configuration Descriptor — required for NOTIFY
    private static final UUID CCCD_UUID        = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private BluetoothGattServer gattServer;
    private BluetoothGattCharacteristic stateChar;
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertiseCallback;
    private final Set<BluetoothDevice> connectedDevices = new HashSet<>();
    private byte[] currentState = "{}".getBytes(StandardCharsets.UTF_8);

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                connectedDevices.add(device);
                JSObject data = new JSObject();
                data.put("deviceId", device.getAddress());
                notifyListeners("bleConnected", data);
            } else {
                connectedDevices.remove(device);
                JSObject data = new JSObject();
                data.put("deviceId", device.getAddress());
                notifyListeners("bleDisconnected", data);
            }
        }

        @Override
        public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset,
                                                BluetoothGattCharacteristic characteristic) {
            if (!STATE_CHAR_UUID.equals(characteristic.getUuid())) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null);
                return;
            }
            int end = Math.min(currentState.length, offset + 512);
            byte[] chunk = (offset < currentState.length)
                    ? Arrays.copyOfRange(currentState, offset, end)
                    : new byte[0];
            gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk);
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                                                 BluetoothGattCharacteristic characteristic,
                                                 boolean preparedWrite, boolean responseNeeded,
                                                 int offset, byte[] value) {
            if (!STATE_CHAR_UUID.equals(characteristic.getUuid())) {
                if (responseNeeded) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null);
                }
                return;
            }
            currentState = value;
            if (responseNeeded) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            }
            JSObject data = new JSObject();
            data.put("state", new String(value, StandardCharsets.UTF_8));
            notifyListeners("bleStateUpdate", data);
        }

        @Override
        public void onDescriptorWriteRequest(BluetoothDevice device, int requestId,
                                             BluetoothGattDescriptor descriptor,
                                             boolean preparedWrite, boolean responseNeeded,
                                             int offset, byte[] value) {
            if (responseNeeded) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            }
        }
    };

    @PluginMethod
    public void startServer(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && getPermissionState("ble") != PermissionState.GRANTED) {
            requestPermissionForAlias("ble", call, "onBlePermissionResult");
            return;
        }
        doStartServer(call);
    }

    @PermissionCallback
    private void onBlePermissionResult(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || getPermissionState("ble") == PermissionState.GRANTED) {
            doStartServer(call);
            return;
        }
        call.reject("Bluetooth permissions denied");
    }

    private void doStartServer(PluginCall call) {
        try {
            stopServerInternal();

        Context context = getContext();
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (manager == null) {
            call.reject("Bluetooth not available on this device");
            return;
        }
        BluetoothAdapter adapter = manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is not enabled");
            return;
        }

        gattServer = manager.openGattServer(context, serverCallback);
        if (gattServer == null) {
            call.reject("Failed to open GATT server");
            return;
        }

        BluetoothGattService service = new BluetoothGattService(
                SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);

        stateChar = new BluetoothGattCharacteristic(
                STATE_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ
                        | BluetoothGattCharacteristic.PROPERTY_WRITE
                        | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ
                        | BluetoothGattCharacteristic.PERMISSION_WRITE);

        BluetoothGattDescriptor cccd = new BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE);
        stateChar.addDescriptor(cccd);
        service.addCharacteristic(stateChar);
        gattServer.addService(service);

        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            // GATT server open, but advertising unavailable (emulator / BLE-only device)
            call.resolve();
            return;
        }

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .build();

        AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(true)
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();

        advertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                call.resolve();
            }

            @Override
            public void onStartFailure(int errorCode) {
                call.reject("BLE advertising failed (code " + errorCode + ")");
            }
        };

        advertiser.startAdvertising(settings, data, advertiseCallback);
        } catch (SecurityException se) {
            stopServerInternal();
            call.reject("BLE permission error: " + se.getMessage(), se);
        } catch (Exception ex) {
            stopServerInternal();
            call.reject("BLE server start failed: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        stopServerInternal();
        call.resolve();
    }

    private void stopServerInternal() {
        if (advertiser != null && advertiseCallback != null) {
            try { advertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) {}
            advertiser = null;
            advertiseCallback = null;
        }
        if (gattServer != null) {
            gattServer.close();
            gattServer = null;
        }
        connectedDevices.clear();
    }

    @PluginMethod
    public void updateState(PluginCall call) {
        String json = call.getString("state", "{}");
        currentState = json.getBytes(StandardCharsets.UTF_8);
        if (stateChar != null && gattServer != null && !connectedDevices.isEmpty()) {
            stateChar.setValue(currentState);
            for (BluetoothDevice device : connectedDevices) {
                gattServer.notifyCharacteristicChanged(device, stateChar, false);
            }
        }
        call.resolve();
    }
}
