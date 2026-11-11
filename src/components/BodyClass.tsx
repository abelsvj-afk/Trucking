"use client";
// Sets a class on <body> while the component is mounted (used by
// Home to scope its mockup-face header treatment without touching
// the shared PageHeader used by every other screen).
import { useEffect } from "react";

export default function BodyClass({ name }: { name: string }) {
  useEffect(() => {
    document.body.classList.add(name);
    return () => {
      document.body.classList.remove(name);
    };
  }, [name]);
  return null;
}
