package com.truckingos.tracker;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The floating HOS overlay's plugin (app-local, so it is registered
        // by hand - Capacitor only auto-discovers plugins from libraries).
        registerPlugin(HosOverlayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
