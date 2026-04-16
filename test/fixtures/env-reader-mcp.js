#!/usr/bin/env node
/**
 * Test fixture: exposes one tool `read_env` that returns the value of a
 * requested env var from the child's own process.env. Used to verify the
 * gateway's ${VAR} interpolation.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "env-reader-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_env",
      description: "Return the value of a given env var visible to this child.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "read_env") throw new Error(`Unknown tool: ${req.params.name}`);
  const key = req.params.arguments?.key;
  const value = process.env[key];
  return {
    content: [{ type: "text", text: value === undefined ? "<undefined>" : value }],
  };
});

await server.connect(new StdioServerTransport());
