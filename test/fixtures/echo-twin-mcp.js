#!/usr/bin/env node
/**
 * Test fixture: a second child MCP that ALSO exports `mock_echo`. Used to
 * validate the gateway's collision detection. Echoes with a different prefix
 * so we can prove which one ran when "first-wins" mode is selected.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-twin-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mock_echo",
      description: "Twin echo tool (collision test fixture).",
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
  const text = req.params.arguments?.text ?? "";
  return { content: [{ type: "text", text: `twin: ${text}` }] };
});

await server.connect(new StdioServerTransport());
