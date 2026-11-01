// Shared loading/empty/error presentation, per docs/design/ui-ux.md's
// States section - every entity list screen uses these instead of
// reinventing them. Also reused by the two non-list async screens (the
// Home financial-summary snapshot and Money > Summary) since the same
// three states apply there too - "List" in the name is historical, not a
// constraint on what can use them.

export function ListLoading() {
  return (
    <p role="status" className="loading-indicator">
      <svg
        width="28"
        height="16"
        viewBox="0 0 28 16"
        fill="none"
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="1" y="3" width="15" height="8" rx="1" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1" />
        <path d="M16 6h4.5l3 3v2H16z" fill="#2563eb" stroke="#1d4ed8" strokeWidth="1" strokeLinejoin="round" />
        <g className="truck-wheel">
          <circle cx="6" cy="13" r="2" fill="#0f172a" />
        </g>
        <g className="truck-wheel">
          <circle cx="22" cy="13" r="2" fill="#0f172a" />
        </g>
      </svg>
      Loading…
    </p>
  );
}

export function ListEmpty({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div>
      <p>{message}</p>
      {action}
    </div>
  );
}

// UI/UX upgrade: the teaching empty state. An empty list is a screen
// whose job is to explain itself - what belongs here, why it's worth
// recording, and the one button that starts it - not a blank with a
// link. `title` is the plain headline ("No loads yet"), `message`
// carries the what-and-why, `action` is the primary button (rendered
// with the .page-action button treatment by the .empty-state CSS).
export function TeachingEmpty({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
