#!/usr/bin/env node
/**
 * @devli13/mcp-gateway
 *
 * Aggregates N child MCP servers behind a single stdio MCP interface.
 * Add an MCP once -> every model client (Claude Code, Gemini CLI, etc.) sees it.
 * Add a model once -> every MCP is already wired.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
const VERSION = PKG.version;

const CONFIG_PATH = process.env.MCP_GATEWAY_CONFIG || resolve(process.cwd(), "gateway.config.json");

const STARTUP_TIMEOUT_MS = Number(process.env.MCP_GATEWAY_STARTUP_TIMEOUT_MS) || 30000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.MCP_GATEWAY_SHUTDOWN_TIMEOUT_MS) || 2000;

// Minimal env passed to child MCPs by default. envFile + inline env on top.
// Set "inheritEnv": true on a child (or globally) to opt back into full process.env passthrough.
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "TERM"];

const log = (...args) => {
  const parts = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
  process.stderr.write(`[mcp-gateway] ${parts.join(" ")}\n`);
};

function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}. Set MCP_GATEWAY_CONFIG or place gateway.config.json in cwd.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadEnvFile(path) {
  if (!path) return {};
  if (!existsSync(path)) {
    log(`warning: envFile ${path} does not exist, skipping`);
    return {};
  }
  const env = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// Replace ${VAR} references in a string using the supplied source env.
// Missing vars expand to "" (matches common shell substitution semantics) and
// are logged so misconfiguration is visible.
function interpolateEnvValue(value, source, contextLabel) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const resolved = source[name];
    if (resolved === undefined) {
      log(`warning: ${contextLabel} referenced $\{${name}\} which is not defined in the gateway's environment`);
      return "";
    }
    return resolved;
  });
}

function buildChildEnv(spec, inheritDefault, childName) {
  const inherit = spec.inheritEnv ?? inheritDefault;
  const base = inherit
    ? { ...process.env }
    : Object.fromEntries(ENV_ALLOWLIST.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  const inlineRaw = spec.env || {};
  const inline = Object.fromEntries(
    Object.entries(inlineRaw).map(([k, v]) => [k, interpolateEnvValue(v, process.env, `child[${childName}].env.${k}`)])
  );
  return {
    ...base,
    ...loadEnvFile(spec.envFile),
    ...inline,
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startChild(name, spec, inheritDefault, onDegraded) {
  const env = buildChildEnv(spec, inheritDefault, name);
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args || [],
    env,
    cwd: spec.cwd,
    stderr: "inherit",
  });

  const client = new Client(
    { name: `mcp-gateway-client/${name}`, version: VERSION },
    { capabilities: {} }
  );

  // Accept either snake_case (matches Claude Code's .mcp.json convention) or camelCase.
  const disabledTools = new Set(spec.disabled_tools || spec.disabledTools || []);

  const child = {
    name,
    client,
    transport,
    tools: [],
    resources: [],
    prompts: [],
    disabledTools,
    degraded: false,
    error: null,
  };

  const markDegraded = (reason) => {
    if (child.degraded) return;
    child.degraded = true;
    child.error = reason;
    child.tools = [];
    child.resources = [];
    child.prompts = [];
    log(`[${name}] degraded: ${reason}`);
    onDegraded?.(child);
  };

  await withTimeout(client.connect(transport), STARTUP_TIMEOUT_MS, `[${name}] connect`);

  // Wire crash detection AFTER successful connect.
  transport.onclose = () => markDegraded("transport closed");
  transport.onerror = (e) => markDegraded(`transport error: ${e?.message ?? String(e)}`);
  // StdioClientTransport spawns the child via @modelcontextprotocol/sdk; the spawned
  // ChildProcess is exposed as transport.process in current SDK versions.
  transport.process?.once?.("exit", (code, sig) =>
    markDegraded(`child exited code=${code} signal=${sig}`)
  );

  try {
    const rawTools = (await withTimeout(client.listTools(), STARTUP_TIMEOUT_MS, `[${name}] listTools`)).tools || [];
    child.tools = rawTools.filter((t) => !disabledTools.has(t.name));
    const hidden = rawTools.length - child.tools.length;
    if (hidden > 0) {
      log(`[${name}] hiding ${hidden} disabled tool(s): ${[...disabledTools].join(", ")}`);
    }
  } catch (e) {
    log(`[${name}] listTools failed: ${e.message}`);
  }
  try {
    child.resources = (await withTimeout(client.listResources(), STARTUP_TIMEOUT_MS, `[${name}] listResources`)).resources || [];
  } catch {
    /* optional capability */
  }
  try {
    child.prompts = (await withTimeout(client.listPrompts(), STARTUP_TIMEOUT_MS, `[${name}] listPrompts`)).prompts || [];
  } catch {
    /* optional capability */
  }

  log(
    `[${name}] connected: ${child.tools.length} tools, ${child.resources.length} resources, ${child.prompts.length} prompts`
  );
  return child;
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  const specs = config.mcpServers || {};
  const onCollision = config.onCollision || "fail"; // "fail" | "first-wins"
  const inheritEnvDefault = config.inheritEnv === true;
  log(`loading ${Object.keys(specs).length} child MCPs from ${CONFIG_PATH}`);

  const server = new Server(
    { name: "@devli13/mcp-gateway", version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  const notifyToolsChanged = () => {
    try {
      server.sendToolListChanged?.();
    } catch {
      /* server not yet connected, or method unavailable in this SDK version */
    }
  };

  const children = [];
  for (const [name, spec] of Object.entries(specs)) {
    try {
      children.push(await startChild(name, spec, inheritEnvDefault, () => notifyToolsChanged()));
    } catch (e) {
      log(`[${name}] FAILED to start: ${e.message}`);
      children.push({
        name,
        client: null,
        transport: null,
        tools: [],
        resources: [],
        prompts: [],
        degraded: true,
        error: e.message,
      });
    }
  }

  const toolMap = new Map();
  const resourceMap = new Map();
  const promptMap = new Map();
  const collisions = [];

  for (const c of children) {
    if (c.degraded) continue;
    for (const t of c.tools) {
      if (toolMap.has(t.name)) {
        collisions.push(`tool:${t.name} (kept=${toolMap.get(t.name).name}, conflict=${c.name})`);
      } else {
        toolMap.set(t.name, c);
      }
    }
    for (const r of c.resources) {
      if (resourceMap.has(r.uri)) {
        collisions.push(`resource:${r.uri} (kept=${resourceMap.get(r.uri).name}, conflict=${c.name})`);
      } else {
        resourceMap.set(r.uri, c);
      }
    }
    for (const p of c.prompts) {
      if (promptMap.has(p.name)) {
        collisions.push(`prompt:${p.name} (kept=${promptMap.get(p.name).name}, conflict=${c.name})`);
      } else {
        promptMap.set(p.name, c);
      }
    }
  }

  if (collisions.length) {
    const summary = `Name collisions across children: ${collisions.join(", ")}`;
    if (onCollision === "fail") {
      throw new Error(
        `${summary}\nSet "onCollision": "first-wins" in gateway.config.json to override, or rename in one of the children.`
      );
    }
    log(`WARN: ${summary} (onCollision=first-wins, keeping first-seen)`);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    for (const c of children) {
      if (c.degraded) continue;
      for (const t of c.tools) tools.push(t);
    }
    tools.push({
      name: "gateway_health",
      description:
        "Report status of every child MCP aggregated by this gateway. No arguments. Returns each child's name, degraded flag, error message if any, and tool/resource/prompt counts.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    if (name === "gateway_health") {
      const status = children.map((c) => ({
        name: c.name,
        degraded: c.degraded,
        error: c.error || null,
        tools: c.tools.length,
        resources: c.resources.length,
        prompts: c.prompts.length,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }

    const child = toolMap.get(name);
    if (!child) throw new Error(`Tool not found: ${name}`);
    if (child.degraded) {
      throw new Error(`Tool ${name} unavailable: child ${child.name} is degraded (${child.error || "no error recorded"})`);
    }
    // Defense-in-depth: tools filtered at listTools already won't appear in toolMap,
    // but verify here too in case a stale map entry survives configuration changes.
    if (child.disabledTools?.has(name)) {
      throw new Error(`Tool ${name} is disabled for child ${child.name} by gateway config`);
    }

    const start = Date.now();
    try {
      const result = await child.client.callTool({ name, arguments: args });
      log(`tool ${name} via ${child.name} OK ${Date.now() - start}ms`);
      return result;
    } catch (e) {
      log(`tool ${name} via ${child.name} ERR ${Date.now() - start}ms: ${e.message}`);
      throw e;
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [];
    for (const c of children) {
      if (c.degraded) continue;
      for (const r of c.resources) resources.push(r);
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const child = resourceMap.get(uri);
    if (!child) throw new Error(`Resource not found: ${uri}`);
    if (child.degraded) throw new Error(`Resource ${uri} unavailable: child ${child.name} is degraded`);
    return await child.client.readResource({ uri });
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = [];
    for (const c of children) {
      if (c.degraded) continue;
      for (const p of c.prompts) prompts.push(p);
    }
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const child = promptMap.get(name);
    if (!child) throw new Error(`Prompt not found: ${name}`);
    if (child.degraded) throw new Error(`Prompt ${name} unavailable: child ${child.name} is degraded`);
    return await child.client.getPrompt({ name, arguments: args });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    `ready: ${toolMap.size} tools, ${resourceMap.size} resources, ${promptMap.size} prompts (${children.length} children, ${children.filter((c) => c.degraded).length} degraded)`
  );

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${sig}, shutting down ${children.length} children`);

    const closeOne = async (c) => {
      if (!c.client) return;
      try {
        await withTimeout(c.client.close(), SHUTDOWN_TIMEOUT_MS, `[${c.name}] close`);
      } catch (e) {
        log(`[${c.name}] close failed: ${e.message}, killing`);
        try {
          c.transport?.process?.kill?.("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    };

    await Promise.allSettled(children.map(closeOne));
    log("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGQUIT", () => shutdown("SIGQUIT"));
}

main().catch((e) => {
  process.stderr.write(`[mcp-gateway] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
