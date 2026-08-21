"use client";

// Task 3.12 (TASKS.md) accessibility pass: every route was sharing the
// single static <title> from app/layout.tsx ("Trucking OS"), which fails
// WCAG 2.4.2 (Page Titled) - a screen-reader user switching tabs or
// checking browser history can't tell one screen from another. Client
// components can't export Next.js `metadata` (that's a Server Component
// feature), so this sets document.title directly - the standard technique
// for client-rendered routes. Server-component index pages (fleet/money/
// more) use `export const metadata` instead; see those files.

import { useEffect } from "react";

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — Trucking OS`;
  }, [title]);
}
