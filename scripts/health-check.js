#!/usr/bin/env node
/**
 * Standalone health check for the MCP gateway.
 *
 * Spawns the gateway with the given MCP_GATEWAY_CONFIG, sends `initialize`
 * and `tools/call gateway_health`, prints the JSON array of child status
 * objects to stdout, exits. Used by Paperclip's periodic MCP healthcheck to
 * introspect a gateway's children without shelling into `claude mcp list`.
 *
 * Usage:
 *   MCP_GATEWAY_CONFIG=/etc/paperclip/mcp-gateway/bridge.json \
 *     node scripts/health-check.js
 *
 * Output (stdout):
 *   [{"name":"notion","degraded":false,"error":null,"tools":22,"resources":0,"prompts":0}, ...]
 *
 * Exit codes:
 *   0 = gateway responded, JSON printed
 *   1 = gateway failed to start or timed out
 *   2 = bad arguments
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "server.js");

if (!process.env.MCP_GATEWAY_CONFIG) {
  process.stderr.write("MCP_GATEWAY_CONFIG must be set\n");
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.MCP_GATEWAY_HEALTH_TIMEOUT_MS) || 30000;

const proc = spawn("node", [SERVER], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve(msg);
      }
    } catch {
      /* partial or unrelated frame */
    }
  }
});

function call(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for id=${id} method=${method}`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  await call(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gateway-health-check", version: "0.1.0" },
  });
  const health = await call(2, "tools/call", { name: "gateway_health", arguments: {} });
  const text = health.result?.content?.[0]?.text;
  if (!text) throw new Error("no content in gateway_health result");
  process.stdout.write(text.trim() + "\n");
  process.exitCode = 0;
} catch (e) {
  process.stderr.write(`[gateway-health-check] ${e.message}\n`);
  process.exitCode = 1;
} finally {
  try { proc.stdin.end(); } catch {}
  proc.kill();
}
