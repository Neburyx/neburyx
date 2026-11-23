import type { Tool, ToolRegistry } from './tool-registry.js';

export interface ToolRequest {
  readonly tool: Tool;
  readonly values: Readonly<Record<string, string>>;
}
