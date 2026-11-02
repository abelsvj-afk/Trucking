// Cleanup incidents (Reliability Unit A / F-038 record shape, design
// A.7): storage objects with no owning documents row, recorded when a
// compensating removal failed. GET lists the company's OPEN incidents
// for the Documents page banner; resolution happens through the retry
// endpoint (./[id]/retry). Tenant isolation is the table's RLS, like
// every other resource - this route adds no filtering of its own.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";

export const GET = createApiHandler(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cleanup_incidents")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return NextResponse.json({ data: data ?? [] });
});
