// Shape of GET/PATCH /api/v1/ai-settings, per docs/api-contracts.md.
export interface AiSettings {
  globally_disabled: boolean;
  capabilities: Record<string, boolean>;
}
