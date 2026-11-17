// @vitest-environment jsdom
//
// The 3D choice is ONE preference shared by Home and Drive (owner
// 2026-11-17): the Home map went flat because it never read the
// Drive page's key. Default ON — the driving map is 3D unless he
// turned it off.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  DRIVE_3D_VIEW_STORAGE_KEY,
  readDrive3dView,
  useDrive3dView,
  writeDrive3dView,
} from "@/lib/drive-3d-view";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("drive 3D preference", () => {
  it("defaults ON when nothing is stored", () => {
    expect(readDrive3dView()).toBe(true);
  });

  it("reads the stored choice: \"0\" is flat, anything else is 3D", () => {
    window.localStorage.setItem(DRIVE_3D_VIEW_STORAGE_KEY, "0");
    expect(readDrive3dView()).toBe(false);
    window.localStorage.setItem(DRIVE_3D_VIEW_STORAGE_KEY, "1");
    expect(readDrive3dView()).toBe(true);
  });

  it("writes the choice back as \"1\" / \"0\"", () => {
    writeDrive3dView(false);
    expect(window.localStorage.getItem(DRIVE_3D_VIEW_STORAGE_KEY)).toBe("0");
    writeDrive3dView(true);
    expect(window.localStorage.getItem(DRIVE_3D_VIEW_STORAGE_KEY)).toBe("1");
  });

  it("the hook starts ON, then reads the stored choice on mount", async () => {
    window.localStorage.setItem(DRIVE_3D_VIEW_STORAGE_KEY, "0");
    const { result } = renderHook(() => useDrive3dView());
    expect(result.current[0]).toBe(true); // before the mount read
    await waitFor(() => expect(result.current[0]).toBe(false));
  });

  it("the hook's setter flips the view and persists it", async () => {
    const { result } = renderHook(() => useDrive3dView());
    await waitFor(() => expect(result.current[0]).toBe(true));
    act(() => {
      result.current[1]((prev) => !prev);
    });
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem(DRIVE_3D_VIEW_STORAGE_KEY)).toBe("0");
  });
});
