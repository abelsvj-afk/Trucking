// Drive's "run ended" screen (file decomposition of the Drive page,
// 2026-11-06; markup and behavior unchanged).

import Link from "next/link";
import DriveStatusPrompt from "./DriveStatusPrompt";
import type { DrivePlanSnapshot } from "@/lib/drive";

export default function DriveRunEnded({ plan, finalReview }: { plan: DrivePlanSnapshot; finalReview: string[] }) {
  return (
  <section aria-label="Run ended">
    <h2>Run ended</h2>
    <p>The run is closed and its checkpoint cleared.</p>
    <DriveStatusPrompt offer={["off_duty", "on_duty"]} />
    {finalReview.length > 0 && (
      <>
        <h3>How the day went</h3>
        {finalReview.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </>
    )}
    <p>
      <Link href="/smart-path">Back to the plan</Link> · <Link href="/">Home</Link>
    </p>
  </section>
  );
}
