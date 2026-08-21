// Fleet tab index. Per docs/design/ui-ux.md, Fleet's own sections
// (Trucks/Trailers/Drivers/Maintenance) are reached via a segmented
// control at the top of this tab - links added here as each lands
// (tasks 3.1-3.3, 3.9), not built ahead of what exists.
import Link from "next/link";

export default function FleetPage() {
  return (
    <div>
      <h1>Fleet</h1>
      <ul>
        <li>
          <Link href="/fleet/trucks">Trucks</Link>
        </li>
        <li>
          <Link href="/fleet/trailers">Trailers</Link>
        </li>
        <li>
          <Link href="/fleet/drivers">Drivers</Link>
        </li>
      </ul>
    </div>
  );
}
