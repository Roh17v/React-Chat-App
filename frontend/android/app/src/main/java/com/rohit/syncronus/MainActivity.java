package com.rohit.syncronus;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NativeWebRTCPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
