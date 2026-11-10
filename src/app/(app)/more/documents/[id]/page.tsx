"use client";

// The document page (UI/UX Phase 3, spec §2.3): /more/documents/[id].
// One document, full-screen, linkable — replaces the inline preview.

import { use, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";
import DocumentViewer from "@/components/DocumentViewer";
import { usePageTitle } from "@/lib/use-page-title";
import type { DocumentWithSignedUrl } from "@/types/entities";

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Document");
  const [doc, setDoc] = useState<DocumentWithSignedUrl | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getDocument<DocumentWithSignedUrl>(id)
      .then((row) => { if (!cancelled) setDoc(row); })
      .catch(() => { if (!cancelled) setError("Couldn't load this document. Check the connection and try again."); });
    return () => { cancelled = true; };
  }, [id]);

  if (error) return <ListError message={error} onRetry={() => window.location.reload()} />;
  if (!doc) return <ListLoading />;
  return <DocumentViewer doc={doc} />;
}
