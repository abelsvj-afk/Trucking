"use client";

// The live layer (docs/design/driver-hud.md §4). ONE Realtime channel
// for the signed-in app; each table carries a version number that data
// hooks watch and re-fetch on. Three triggers bump a table:
//   1. a Realtime change event (RLS-filtered by Supabase for this
//      session; throttled so a burst becomes one re-fetch),
//   2. a write this tab just made (instant local refresh),
//   3. the page becoming visible again (safety net for anything the
//      channel missed while the phone was asleep).
// `connected` is true ONLY while the channel is actually subscribed
// with a signed-in session - that is the sole basis for "Live".

import { createContext, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/services/db/client";
import { MUTATION_EVENT } from "@/lib/api-client";
import { LIVE_TABLES, tableForApiPath, type LiveTable } from "@/lib/live-tables";

export const LIVE_THROTTLE_MS = 1500;

export type LiveVersions = Record<LiveTable, number>;

export interface LiveContextValue {
  versions: LiveVersions;
  connected: boolean;
}

const ZERO = Object.fromEntries(LIVE_TABLES.map((t) => [t, 0])) as LiveVersions;

export const LiveContext = createContext<LiveContextValue>({ versions: ZERO, connected: false });

export default function LiveDataProvider({ children }: { children: React.ReactNode }) {
  const [versions, setVersions] = useState<LiveVersions>(ZERO);
  const [connected, setConnected] = useState(false);
  const pending = useRef(new Map<LiveTable, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = pending.current;
    const bumpNow = (tables: readonly LiveTable[]) =>
      setVersions((prev) => {
        const next = { ...prev };
        for (const t of tables) next[t] = prev[t] + 1;
        return next;
      });
    const bumpThrottled = (table: LiveTable) => {
      if (timers.has(table)) return;
      timers.set(
        table,
        setTimeout(() => {
          timers.delete(table);
          bumpNow([table]);
        }, LIVE_THROTTLE_MS),
      );
    };

    const onMutation = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path ?? "";
      const table = tableForApiPath(path);
      if (table) bumpNow([table]);
    };
    const onVisibility = () => {
      if (!document.hidden) bumpNow(LIVE_TABLES);
    };
    window.addEventListener(MUTATION_EVENT, onMutation);
    document.addEventListener("visibilitychange", onVisibility);

    let cancelled = false;
    let teardown: (() => void) | null = null;
    let supabase: ReturnType<typeof createClient> | null = null;
    try {
      supabase = createClient();
    } catch {
      supabase = null; // no browser config: the app works, just not live
    }
    if (supabase) {
      const client = supabase;
      void client.auth.getSession().then(({ data }) => {
        const token = data.session?.access_token;
        if (cancelled || !token) return; // no session = never subscribe as anon
        client.realtime.setAuth(token);
        let channel = client.channel(`live-${crypto.randomUUID()}`);
        for (const table of LIVE_TABLES) {
          channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, () =>
            bumpThrottled(table),
          );
        }
        channel.subscribe((status) => {
          if (!cancelled) setConnected(status === "SUBSCRIBED");
        });
        teardown = () => {
          void client.removeChannel(channel);
        };
      });
    }

    return () => {
      cancelled = true;
      window.removeEventListener(MUTATION_EVENT, onMutation);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      teardown?.();
    };
  }, []);

  const value = useMemo(() => ({ versions, connected }), [versions, connected]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
