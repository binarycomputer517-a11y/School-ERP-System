package com.bcsmerp.app;

import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // This allows the Android WebView to handle the JavaScript 
        // camera/microphone requests (navigator.mediaDevices.getUserMedia)
        this.bridge.getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // This line tells Android to grant the permission requested by the web page
                request.grant(request.getResources());
            }
        });
    }
}