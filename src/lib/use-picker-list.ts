"use client";

// Fetches a full list for populating a <select> dropdown - drivers/new
// used this pattern for trucks; loads/new needs it four times (truck,
// driver, broker, customer), so it's worth sharing now rather than
// copy-pasting the same effect four times in one file.

import { useEffect, useState } from "react";
import { apiClient } from "./api-client";

export function usePickerList<T>(resource: string) {
  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    apiClient
      .list<T>(resource, { limit: "200" })
      .then((result) => setItems(result.data))
      .catch(() => setItems([]));
  }, [resource]);

  return items;
}
