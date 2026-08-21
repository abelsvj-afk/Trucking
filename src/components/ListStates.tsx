// Shared loading/empty/error presentation, per docs/design/ui-ux.md's
// States section - every entity list screen uses these instead of
// reinventing them. Also reused by the two non-list async screens (the
// Home financial-summary snapshot and Money > Summary) since the same
// three states apply there too - "List" in the name is historical, not a
// constraint on what can use them.

export function ListLoading() {
  return <p role="status">Loading…</p>;
}

export function ListEmpty({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div>
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
