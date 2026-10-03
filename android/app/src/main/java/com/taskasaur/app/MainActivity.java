package com.taskasaur.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle state) {
        registerPlugin(ReplicaStoragePlugin.class);
        super.onCreate(state);
    }
}
