"use client";

// Idempotent-create hook (Reliability Unit A / F-006, design A.6).
//
// A create form generates ONE submission token when it opens. Every
// submit attempt from that form instance - double-tap, retry after a
// timeout, retry after a network error - carries the SAME token, so
// the server can replay the original create instead of inserting a
// duplicate. Opening the form again (a genuinely new record the user
// intends to create) generates a fresh token: the hook's lifetime is
// the form's mount, and create forms unmount on success navigation.

import { useState } from "react";

export function useSubmissionId(): string {
  const [submissionId] = useState(() => crypto.randomUUID());
  return submissionId;
}
