// UI/UX upgrade: every screen's header - the title plus the one-line
// plain-language purpose statement the owner asked for ("you don't
// really know what anything is for"). A screen that can't say in one
// line what it's for doesn't ship. `action` is the screen's primary
// button (usually its Add link), given a real button treatment by the
// .page-action class in globals.css instead of a bare text link.

export default function PageHeader({
  title,
  purpose,
  action,
}: {
  title: string;
  purpose: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        <p className="page-purpose">{purpose}</p>
      </div>
      {action}
    </header>
  );
}
