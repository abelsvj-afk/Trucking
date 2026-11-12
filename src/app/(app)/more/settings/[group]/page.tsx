"use client";

// One settings group on its own page (docs/design/settings-index.md). The group comes from the URL; an
// unknown one shows the way back instead of an empty page.

import Link from "next/link";
import { useParams } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import SettingsGroupView from "@/components/settings/SettingsGroupView";
import { usePageTitle } from "@/lib/use-page-title";
import { groupBySlug } from "@/lib/settings-groups";

export default function SettingsGroupPage() {
  const params = useParams<{ group: string }>();
  const group = groupBySlug(params?.group);
  usePageTitle(group ? group.label : "Settings");

  if (!group) {
    return (
      <div>
        <PageHeader title="Account & settings" purpose="That settings page doesn't exist." />
        <p>
          <Link href="/more/settings">Back to all settings</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="settings-group-page">
      <PageHeader title={group.label} purpose={group.desc} />
      <SettingsGroupView group={group.slug} />
      <p className="settings-back">
        <Link href="/more/settings">All settings</Link>
      </p>
    </div>
  );
}
