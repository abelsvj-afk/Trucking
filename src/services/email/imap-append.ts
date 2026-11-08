// The ONLY write this build ever makes to a server mailbox (docs/design/abel-email-access.md addendum): after a send, append a copy of
// the sent message to the mailbox's Sent folder. It touches one folder, only ever ADDS a message, and never reads, moves, flags or deletes
// existing mail. Best-effort by contract: it returns false (never throws) so a failed copy can't undo a send that already happened; the
// caller records the failure.

import { ImapFlow } from "imapflow";
import type { EmailConfig } from "./config";

const SENT_NAMES = /^(sent|sent items|sent messages|gesendet|gesendete objekte|gesendete elemente)$/i;

export async function appendToSentFolder(config: EmailConfig, raw: Buffer): Promise<boolean> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    emitLogs: false,
    socketTimeout: 60_000,
    greetingTimeout: 20_000,
    connectionTimeout: 20_000,
  });
  client.on("error", () => {
    /* surfaced through the rejected operation */
  });
  try {
    await client.connect();
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === "\\Sent") ?? folders.find((f) => SENT_NAMES.test(f.name) || SENT_NAMES.test(f.path));
    await client.append(sent?.path ?? "Sent", raw, ["\\Seen"]);
    return true;
  } catch (err) {
    console.error("[email] could not append the sent copy to the Sent folder", err instanceof Error ? err.name : "error");
    return false;
  } finally {
    await client.logout().catch(() => client.close());
  }
}
