import { HAR_AGENT_SLOT_MIN, HAR_STAGE_KINDS } from '../harness/schema';

export const repoJsonProperty = {
  type: 'string' as const,
  description: 'Path to the repository',
};

export const agentIdJsonProperty = {
  type: 'number' as const,
  minimum: HAR_AGENT_SLOT_MIN,
  description:
    'Agent slot id. Must be within the agentSlots range configured in .har/stages.json (see har_describe_project).',
};

export const stageKindJsonProperty = {
  type: 'string' as const,
  enum: [...HAR_STAGE_KINDS],
};

export function objectJsonSchema(
  properties: Record<string, object>,
  required?: string[],
): { type: 'object'; properties: Record<string, object>; required?: string[] } {
  return {
    type: 'object',
    properties,
    ...(required?.length ? { required } : {}),
  };
}
