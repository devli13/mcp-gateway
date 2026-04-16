#!/usr/bin/env node
/**
 * Minimal child MCP used as an integration-test fixture.
 * Exposes a single `mock_echo` tool that echoes its input.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mock-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mock_echo",
      description: "Echo back the input text. Test fixture only.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "mock_echo") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  const text = req.params.arguments?.text ?? "";
  return {
    content: [{ type: "text", text: `echo: ${text}` }],
  };
});

await server.connect(new StdioServerTransport());
