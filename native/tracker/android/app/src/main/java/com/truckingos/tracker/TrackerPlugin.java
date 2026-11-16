package com.truckingos.tracker;

// The page's handle on the native TrackerService: ask for the permissions it needs, start and stop it, and
// read its status and log. The server URL and key are handed to the service here and kept in the app's
// private storage on the phone only.

import android.Manifest;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

@CapacitorPlugin(
    name = "Tracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }),
    }
)
public class TrackerPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        String server = call.getString("server", "");
        String key = call.getString("key", "");
        if (server == null || server.isEmpty() || key == null || key.isEmpty()) {
            call.reject("Save the server URL and your device key first.");
            return;
        }
        TrackerService.prefs(getContext()).edit().putString("server", server).putString("key", key).apply();
        boolean needNotif = Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED;
        if (getPermissionState("location") != PermissionState.GRANTED || needNotif) {
            requestPermissionForAliases(new String[] { "location", "notifications" }, call, "afterPermissions");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void afterPermissions(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Location permission is off. In phone Settings -> Apps -> Trucking OS Tracker -> Permissions, allow Location, then tap Start again.", "NOT_AUTHORIZED");
            return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        try {
            TrackerService.start(getContext());
            call.resolve();
        } catch (Exception e) {
            call.reject("Android refused to start background tracking: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        TrackerService.stop(getContext());
        TrackerService.log(getContext(), "INFO", "Tracking stopped.");
        call.resolve();
    }

    /** Keeps the service's copy of the connection in step when Settings are saved mid-shift. */
    @PluginMethod
    public void configure(PluginCall call) {
        TrackerService.prefs(getContext()).edit()
            .putString("server", call.getString("server", ""))
            .putString("key", call.getString("key", ""))
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = TrackerService.prefs(getContext());
        JSObject out = new JSObject();
        out.put("running", p.getBoolean("running", false));
        out.put("queued", TrackerService.readQueue(getContext()).length());
        out.put("lastSentAt", p.getLong("lastSentAt", 0));
        out.put("lastFixAt", p.getLong("lastFixAt", 0));
        out.put("lastError", p.getString("lastError", null));
        try {
            out.put("log", new JSArray(new JSONArray(p.getString("log", "[]")).toString()));
        } catch (Exception e) {
            out.put("log", new JSArray());
        }
        call.resolve(out);
    }

    @PluginMethod
    public void appendLog(PluginCall call) {
        TrackerService.log(getContext(), call.getString("level", "INFO"), call.getString("message", ""));
        call.resolve();
    }

    @PluginMethod
    public void clearLog(PluginCall call) {
        TrackerService.prefs(getContext()).edit().putString("log", "[]").apply();
        call.resolve();
    }
}
