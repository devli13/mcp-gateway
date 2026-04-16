# mcp-gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

A small [MCP (Model Context Protocol)](https://modelcontextprotocol.io) gateway that aggregates many child MCP servers behind a single stdio interface. Add an MCP once and every model client sees it. Add a new model client and every MCP is already wired.

Designed for multi-agent setups where keeping per-model MCP configs (`.mcp.json` for Claude Code, `.gemini/settings.json` for Gemini CLI, etc.) in lockstep has become a maintenance burden.

## Features

- **Single source of truth** -- one `gateway.config.json` lists every child MCP. No more per-model config drift.
- **Transparent stdio passthrough** -- forwards `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get` to the right child without lossy translation.
- **Per-child env file loading** -- each child can specify an `envFile` (KEY=VAL format), useful for systemd-creds split-secret setups.
- **Per-child env isolation by default** -- children get a minimal allowlist (`PATH`, `HOME`, `LANG`, etc.) plus their own `envFile` and inline `env`. No accidental leakage of one child's secrets into another. Opt back in to full inheritance with `inheritEnv: true`.
- **Failure isolation** -- if a child crashes (at startup or mid-session), the gateway marks it degraded, keeps serving the remaining children, and returns clean errors for the dead child's tools instead of hanging.
- **Built-in `gateway_health` tool** -- agents can introspect the live status of every child MCP without leaving the conversation.
- **Tool name collision detection** -- by default, refuses to start if two children export the same tool name. Override with `"onCollision": "first-wins"` if you need to.
- **Per-tool disable list** -- each child can declare `disabled_tools` to hide specific tools from `tools/list` and reject direct calls. Useful for enforcing safety rails (e.g. blocking destructive Twitter actions while allowing read-only ones).
- **`${VAR}` env interpolation** -- inline `env` values support `${VAR}` substitution from the gateway's own environment, so secrets handed to the gateway by a parent process (systemd, a launcher, etc.) can be referenced by name without having to copy them into a file.
- **Bounded shutdown** -- `SIGTERM`/`SIGINT`/`SIGQUIT` close all children in parallel with a per-child timeout, then force-kill anything that hangs.
- **Works with Claude Code, Gemini CLI, and any MCP-compatible client.**

## Quick Start

### 1. Install

```bash
npm install @devli13/mcp-gateway
```

Or clone locally:

```bash
git clone https://github.com/devli13/mcp-gateway.git
cd mcp-gateway
npm install
```

### 2. Write a config

Create `gateway.config.json` in your working directory (or anywhere; point `MCP_GATEWAY_CONFIG` at it).

```json
{
  "mcpServers": {
    "paperclip": {
      "command": "npx",
      "args": ["-y", "@devli13/mcp-paperclip"],
      "envFile": "/run/paperclip/mcp/paperclip.env"
    },
    "granola": {
      "command": "npx",
      "args": ["-y", "@devli13/mcp-granola"],
      "envFile": "/run/paperclip/mcp/granola.env"
    },
    "ga4": {
      "command": "npx",
      "args": ["-y", "@devli13/mcp-ga4"],
      "envFile": "/run/paperclip/mcp/ga4.env"
    }
  }
}
```

The shape mirrors Claude Code's `.mcp.json` `mcpServers` block, with one optional addition: `envFile` per child (relative or absolute path to a KEY=VAL file).

### 3. Wire it into your MCP client

In your client's MCP config (`.mcp.json` for Claude Code, `.gemini/settings.json` for Gemini CLI, etc.), point at the gateway as a single entry:

```json
{
  "mcpServers": {
    "gateway": {
      "command": "npx",
      "args": ["-y", "@devli13/mcp-gateway"],
      "env": {
        "MCP_GATEWAY_CONFIG": "/path/to/gateway.config.json"
      }
    }
  }
}
```

That's it. The client now sees the union of every child MCP's tools, resources, and prompts -- transparently, with no per-tool prefix.

## Configuration

Top-level keys:

| Field | Default | Description |
|---|---|---|
| `mcpServers` | `{}` | Map of child-name → child spec (see below) |
| `onCollision` | `"fail"` | Behaviour when two children export the same tool/resource/prompt name. `"fail"` aborts startup with a clear error. `"first-wins"` keeps the first-loaded entry and logs a warning. |
| `inheritEnv` | `false` | If `true`, every child inherits the gateway's full `process.env` by default. Otherwise a minimal allowlist is used. Per-child `inheritEnv` overrides this. |

Per-child fields under `mcpServers.<name>`:

| Field | Required | Description |
|---|---|---|
| `command` | Yes | Executable to spawn (e.g. `npx`, `node`, `python`) |
| `args` | No | Arguments passed to the command |
| `env` | No | Inline env vars merged into the child's environment (highest precedence). Values may reference gateway-process env vars via `${VAR}` syntax; missing vars expand to `""` and log a warning. |
| `envFile` | No | Path to a `KEY=VAL` file loaded into the child's environment. Lines starting with `#`, blank lines, and an optional leading `export ` are ignored. Single- or double-quoted values are unwrapped. Designed for systemd-credential-style files; no dotenv-style escape sequences or interpolation. |
| `cwd` | No | Working directory for the child process |
| `inheritEnv` | inherits top-level | If `true`, this specific child gets full `process.env` inheritance. Useful if a child needs ambient credentials. |
| `disabled_tools` (alias `disabledTools`) | No | Array of tool names to hide. Tools listed here are filtered out of `tools/list` and rejected on direct `tools/call`. Matches Claude Code's `.mcp.json` convention. |

## Environment

| Variable | Default | Description |
|---|---|---|
| `MCP_GATEWAY_CONFIG` | `./gateway.config.json` | Path to the gateway config file |
| `MCP_GATEWAY_STARTUP_TIMEOUT_MS` | `30000` | Per-child startup timeout for `connect` / `listTools` / `listResources` / `listPrompts`. A child that doesn't respond within this window is marked degraded. |
| `MCP_GATEWAY_SHUTDOWN_TIMEOUT_MS` | `2000` | Per-child shutdown timeout. After this expires, the child is `SIGKILL`ed. |

## Built-in tools

The gateway exposes one synthetic tool of its own:

| Tool | Description | Arguments |
|---|---|---|
| `gateway_health` | Returns status of every child MCP: name, degraded flag, error (if any), tool/resource/prompt counts | none |

Useful for agents to introspect their own tool surface ("which of my MCPs are degraded right now?").

## How it works

On startup the gateway:

1. Reads the config file
2. For each child, loads any `envFile`, spawns the child as a stdio MCP subprocess
3. Calls `initialize` then `tools/list` / `resources/list` / `prompts/list` on each child, caches the results
4. Builds a `name -> child` routing map (collision = fail-loud at startup)
5. Exposes itself as a single stdio MCP server to the client

On each `tools/call`:

- Resolves the tool name to its owning child
- Forwards the call raw, returns the response raw
- If the child is degraded (failed startup, transport closed, child process exited), returns a clear error instead of hanging

The gateway watches each child's transport for `close` and `error` events plus the underlying child process's `exit` event. When any of those fire, the child is marked degraded, its tools/resources/prompts are removed from the routing maps, and a `notifications/tools/list_changed` is sent to the connected MCP client (if the SDK exposes the helper). Sibling children are unaffected.

Restart the gateway to attempt re-spawn of degraded children. Hot-reload of child specs (`SIGHUP`) is planned for v0.2.0.

## Why?

Multi-agent systems quickly end up with N agents x M models x K MCPs and a sync watcher trying to keep three different config formats aligned. The gateway collapses that to a single config: every model client sees one MCP server (the gateway), and the gateway handles the fan-out internally. Adding a new MCP becomes "edit one JSON file." Adding a new model becomes "point it at the gateway."

This is deliberately a thin layer on top of the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- ~300 lines of code, zero translation layers, faithful schema passthrough. If MCP evolves, you bump the SDK version.

## Comparison with other tools

| Tool | Inbound transport | Per-child env-file | Aggregator vs. bridge | License |
|---|---|---|---|---|
| **`@devli13/mcp-gateway`** (this) | stdio | yes | aggregator | MIT |
| `sparfenyuk/mcp-proxy` | stdio | partial | bridge (separate URL per child) | MIT |
| `metatool-ai/MetaMCP` | HTTP/SSE only | yes | aggregator | MIT |
| `jlowin/fastmcp` `as_proxy` | stdio (via Python) | yes | aggregator | Apache-2.0 |
| `sitbon/magg` | stdio | no | aggregator | AGPL-3.0 |

If you want a Python-based aggregator with a deep ecosystem, look at FastMCP. If you want a Docker/Postgres multi-tenant gateway, look at MetaMCP. If you want a tiny, focused stdio aggregator that mirrors Claude Code's `.mcp.json` shape, you're in the right place.

## Development

```bash
git clone https://github.com/devli13/mcp-gateway.git
cd mcp-gateway
npm install
npm test
```

## License

MIT -- see [LICENSE](LICENSE).
