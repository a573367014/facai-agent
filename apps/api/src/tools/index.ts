import { calculatorTool } from "./calculator.js";
import { currentTimeTool } from "./current-time.js";
import { ToolRegistry } from "./registry.js";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  registry.register(currentTimeTool);
  return registry;
}
