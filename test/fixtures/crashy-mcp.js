#!/usr/bin/env node
/**
 * Test fixture: a child MCP that exposes a `crash_now` tool which calls
 * process.exit(1). Used to validate post-startup failure isolation.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "crashy-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "crashy_ping",
      description: "Returns pong while alive.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "crash_now",
      description: "Crashes this child MCP. Test fixture only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "crashy_ping") {
    return { content: [{ type: "text", text: "pong" }] };
  }
  if (req.params.name === "crash_now") {
    setTimeout(() => process.exit(1), 10);
    return { content: [{ type: "text", text: "crashing in 10ms" }] };
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

await server.connect(new StdioServerTransport());
