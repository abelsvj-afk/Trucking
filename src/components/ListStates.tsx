// Shared loading/empty/error presentation, per docs/design/ui-ux.md's
// States section - every entity list screen uses these instead of
// reinventing them.

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
