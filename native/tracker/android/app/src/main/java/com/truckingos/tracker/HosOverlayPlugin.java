package com.truckingos.tracker;

import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The web layer's handle on the floating HOS overlay
 * (docs/design/eld-roadside-overlay.md in the main repo). Three calls:
 * canDraw (is the "display over other apps" permission granted),
 * requestPermission (open the system grant screen), show/hide (push the
 * server-computed clocks into HosOverlayState and start/stop the card's
 * service). The plugin itself draws nothing.
 */
@CapacitorPlugin(name = "HosOverlay")
public class HosOverlayPlugin extends Plugin {

    @PluginMethod
    public void canDraw(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", Settings.canDrawOverlays(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void show(PluginCall call) {
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("The \"display over other apps\" permission is not granted.");
            return;
        }
        String statusText = call.getString("statusText", "");
        JSArray rawLines = call.getArray("lines", new JSArray());
        HosOverlayState.Line[] lines = new HosOverlayState.Line[rawLines.length()];
        try {
            for (int i = 0; i < rawLines.length(); i++) {
                JSONObject obj = rawLines.getJSONObject(i);
                lines[i] = new HosOverlayState.Line(
                        obj.optString("label", ""),
                        obj.optLong("remainingMs", 0L),
                        obj.optString("tone", "ok"));
            }
        } catch (JSONException e) {
            call.reject("The clock lines were malformed.");
            return;
        }
        HosOverlayState.set(statusText, lines, SystemClock.elapsedRealtime());
        Intent service = new Intent(getContext(), HosOverlayService.class);
        getContext().startService(service);
        call.resolve();
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getContext().stopService(new Intent(getContext(), HosOverlayService.class));
        call.resolve();
    }
}
