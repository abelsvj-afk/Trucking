// Attach Malik's real tools to the live Telnyx AI assistant.
// LIVE MUTATION — run only on the owner's word. This branch does NOT run it.
//   TELNYX_API_KEY=... TELNYX_ASSISTANT_ID=... MALIK_COMPANY_ID=... \
//     node scripts/malik-attach-tools.mjs --confirm
// Without --confirm it only prints the plan (what it would attach) and exits.
// Env: TELNYX_API_KEY (bearer), TELNYX_ASSISTANT_ID (default Malik's id),
// MALIK_COMPANY_ID (the company UUID baked into each tool URL — never
// model-chosen), APP_BASE_URL (default https://app.roadtolegacytrucking.com).

import { readFileSync } from "node:fs";

const TELNYX_API = "https://api.telnyx.com/v2";
const DEFAULT_ASSISTANT_ID = "assistant-68fca3cb-be34-4801-beea-aa58d320b33b";
const DEFAULT_APP_BASE_URL = "https://app.roadtolegacytrucking.com";

const apiKey = process.env.TELNYX_API_KEY ?? "";
const assistantId = process.env.TELNYX_ASSISTANT_ID ?? DEFAULT_ASSISTANT_ID;
const companyId = process.env.MALIK_COMPANY_ID ?? "";
const appBaseUrl = (process.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL).replace(/\/$/, "");
const confirm = process.argv.includes("--confirm");

if (!apiKey) {
  console.error("Missing TELNYX_API_KEY.");
  process.exit(1);
}
if (!companyId) {
  console.error("Missing MALIK_COMPANY_ID (the company UUID baked into the tool URLs).");
  process.exit(1);
}

const defsPath = new URL("../docs/design/malik-telnyx-tools.json", import.meta.url);
const defs = JSON.parse(readFileSync(defsPath, "utf8"));
const tools = JSON.parse(
  JSON.stringify(defs.tools)
    .replaceAll("{APP_BASE_URL}", appBaseUrl)
    .replaceAll("{COMPANY_ID}", companyId),
);
const instructions = defs.instructions;

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

const currentRes = await fetch(`${TELNYX_API}/ai/assistants/${assistantId}`, { headers });
if (!currentRes.ok) {
  console.error(`Could not read the assistant (${currentRes.status}). Check TELNYX_ASSISTANT_ID.`);
  process.exit(1);
}
const current = await currentRes.json();
const currentTools = current?.data?.tools ?? [];
console.log(`Assistant: ${current?.data?.name ?? assistantId}`);
console.log(`Current tools on the assistant: ${currentTools.length}`);
console.log(`Tools this script would attach: ${tools.map((t) => t.name).join(", ")}`);
console.log(`Tool URLs point at: ${appBaseUrl}/api/telnyx/malik-tools/${companyId}/<tool>`);
console.log(`Instructions would be replaced with the Malik instructions from docs/design/malik-telnyx-tools.json.`);

if (!confirm) {
  console.log("Dry run only — nothing changed. Re-run with --confirm (on the owner's word) to attach.");
  process.exit(0);
}

const patchRes = await fetch(`${TELNYX_API}/ai/assistants/${assistantId}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ tools, instructions }),
});
if (!patchRes.ok) {
  console.error(`Attach failed (${patchRes.status}): ${(await patchRes.text()).slice(0, 500)}`);
  process.exit(1);
}
const patched = await patchRes.json();
console.log(`Attached. Assistant now has ${(patched?.data?.tools ?? []).length} tools.`);
console.log("Next: place a test call to the company number (only on the owner's word) and ask for the active load.");
