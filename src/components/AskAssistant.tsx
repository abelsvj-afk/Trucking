// UI/UX upgrade: the assistant's front door, on the screens where the
// work happens. The owner said he couldn't tell how to interact with
// the AI - so the AI now introduces itself where he already is, with
// example questions he can tap instead of a blank chat box he has to
// invent an opening for. Each prompt links into the Assistant with the
// question pre-typed (?q=), one tap from "what do I even ask?" to a
// conversation already started.

import Link from "next/link";

export default function AskAssistant({
  heading,
  prompts,
}: {
  heading: string;
  prompts: string[];
}) {
  return (
    <section aria-label="Ask the assistant" className="ask-assistant">
      <h2>Ask the assistant</h2>
      <p>{heading}</p>
      <div className="prompt-chips">
        {prompts.map((prompt) => (
          <Link
            key={prompt}
            className="prompt-chip"
            href={`/more/assistant?q=${encodeURIComponent(prompt)}`}
          >
            {prompt}
          </Link>
        ))}
      </div>
      <Link href="/more/assistant" className="ask-assistant-open">
        Open the assistant →
      </Link>
    </section>
  );
}
