import type { ToolDefinition } from "../agent/types.js";
import type { RegisteredTool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolAccessPolicy } from "../tools/access-policy.js";

export interface BindingsTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toBindingsTools(definitions: ToolDefinition[]): BindingsTool[] {
  return definitions.map((definition) => ({
    type: "function" as const,
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters
    }
  }));
}

export function collectToolDefinitions(
  registry: ToolRegistry,
  accessPolicy: ToolAccessPolicy
): ToolDefinition[] {
  return accessPolicy.filterDefinitions(registry.getDefinitions());
}

export function lookupRegisteredTool(
  registry: ToolRegistry,
  name: string
): RegisteredTool | undefined {
  return registry.getTool(name);
}
