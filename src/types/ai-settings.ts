// Shape of GET/PATCH /api/v1/ai-settings, per docs/api-contracts.md.
// call_voice_id is the voice he picked for Abel's outbound calls
// (docs/design/outbound-calling.md): a Telnyx voice id, or null for the
// Telnyx default built-in voice.
export interface AiSettings {
  globally_disabled: boolean;
  capabilities: Record<string, boolean>;
  call_voice_id: string | null;
}
