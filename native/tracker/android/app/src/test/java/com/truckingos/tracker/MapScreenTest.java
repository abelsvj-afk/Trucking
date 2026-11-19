package com.truckingos.tracker;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MapScreenTest {
    @Test
    public void mapUrlIsTheDrivePageOnTheSavedServer() {
        assertEquals("https://app.roadtolegacytrucking.com/smart-path/drive", MapScreen.mapUrl("https://app.roadtolegacytrucking.com/"));
        assertEquals("https://x.example/sub/smart-path/drive", MapScreen.mapUrl("https://x.example/sub"));
    }

    @Test
    public void onlyTheSavedServerLoadsInsideTheApp() {
        assertTrue(MapScreen.isOwnServer("app.roadtolegacytrucking.com", "app.roadtolegacytrucking.com"));
        assertTrue(MapScreen.isOwnServer("APP.roadtolegacytrucking.com", "app.roadtolegacytrucking.com"));
        assertFalse(MapScreen.isOwnServer("evil.example", "app.roadtolegacytrucking.com"));
        assertFalse(MapScreen.isOwnServer(null, "app.roadtolegacytrucking.com"));
        assertFalse(MapScreen.isOwnServer("app.roadtolegacytrucking.com", ""));
    }
}
