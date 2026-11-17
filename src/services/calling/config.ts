// Outbound calling configuration (docs/design/outbound-calling.md).
// Every credential comes from env / Fly secrets - never the repo, never
// a test, never a log. The ElevenLabs key itself lives in the Telnyx
// portal as an Integration Secret; this app never holds it.

/** Kill switch for outbound calling (Settings -> Abel and AI). Default OFF: no row means off. */
export const OUTBOUND_CALLING_CAPABILITY = "outbound_calling";

export interface CallingConfig {
  telnyxApiKey: string | null;
  /** The one shared number every bot calls from, E.164. */
  phoneNumber: string | null;
  /** Telnyx Call Control Application connection id (portal). */
  connectionId: string | null;
  /** Telnyx AI Assistant id (portal). */
  assistantId: string | null;
  /** Telnyx webhook public key, for Ed25519 signature checks. Null = webhooks fail closed. */
  publicKey: string | null;
}

export function getCallingConfig(env: NodeJS.ProcessEnv = process.env): CallingConfig {
  const read = (name: string): string | null => {
    const value = env[name];
    return value && value.trim() ? value.trim() : null;
  };
  return {
    telnyxApiKey: read("TELNYX_API_KEY"),
    phoneNumber: read("TELNYX_PHONE_NUMBER"),
    connectionId: read("TELNYX_CONNECTION_ID"),
    assistantId: read("TELNYX_ASSISTANT_ID"),
    publicKey: read("TELNYX_PUBLIC_KEY"),
  };
}

/** Everything dialing needs. The webhook public key is checked separately - dialing works without it. */
export function isOutboundCallingConfigured(config: CallingConfig): boolean {
  return Boolean(config.telnyxApiKey && config.phoneNumber && config.connectionId && config.assistantId);
}

/** Which piece of setup is missing, in plain words (no secret values, ever). */
export function missingCallingSetup(config: CallingConfig): string | null {
  if (!config.telnyxApiKey) return "the Telnyx API key isn't set";
  if (!config.phoneNumber) return "the shared calling number isn't set";
  if (!config.connectionId) return "the Telnyx Call Control connection isn't set";
  if (!config.assistantId) return "the Telnyx AI assistant isn't set";
  return null;
}
