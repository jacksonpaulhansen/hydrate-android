package com.hydrate.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(HydrateBlePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
