package com.transmilenio.explorer;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate() so the bridge loads the plugin during
        // its own init — VoicePlugin.load() is where recognition starts for a voice
        // launch, and it has to run before the WebView finishes booting for the
        // rider's speech and the page load to overlap (spec §5.9).
        registerPlugin(VoicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
