#!/usr/bin/env python3
"""Migrate Paperclip agents to @devli13/mcp-gateway.

For each agent with an existing `.mcp.json` (other than the ones listed in
SKIP_IDS), this script:

  1. Reads the current `.mcp.json` (authoritative list of child MCPs)
  2. Extracts every `${VAR}` reference used in inline `env` blocks → forwarding list
  3. Writes `/etc/paperclip/mcp-gateway/<slug>.json` (root-owned `644`):
       - same `mcpServers` block
       - `onCollision: fail`
       - `prefixTools: true`
  4. Backs up the existing `.mcp.json` as `.mcp.json.bak-pregateway-<ts>`
  5. Writes a new gateway-only `.mcp.json` (owner `paperclip:paperclip`, mode
     `644`) whose single `gw` entry carries:
       - `MCP_GATEWAY_CONFIG` pointing at the per-agent config file
       - every `${VAR}` secret the gateway's children reference, forwarded
         through Claude Code's own substitution layer

This was used on 2026-04-16 to migrate all eight active Paperclip agents
(Pixel, Bridge, DevOps, CTO, Social, Remotion, Growth, EA) plus the CEO.

Run as root on the Paperclip VPS:

    sudo python3 ops/migrate-agents-to-gateway.py

Preconditions:
  - `/home/paperclip/mcp-gateway/` has the gateway installed (`npm install`
    already run)
  - `/etc/paperclip/mcp-gateway/` exists and is root-owned
  - Paperclip's API is reachable at http://127.0.0.1:3100/

Rollback (per agent):
    sudo install -o paperclip -g paperclip -m 644 \
      <workspace>/.mcp.json.bak-pregateway-<ts> <workspace>/.mcp.json
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

WORKSPACES = Path("/home/paperclip/.paperclip/instances/default/workspaces")
GATEWAY_CONFIG_DIR = Path("/etc/paperclip/mcp-gateway")
GATEWAY_BIN = "/home/paperclip/mcp-gateway/server.js"
STAMP = datetime.now().strftime("%Y%m%d-%H%M%S")

# Agents already migrated in an earlier run. Extend as needed.
SKIP_IDS: set[str] = set()

AGENT_NAMES = {}
try:
    import urllib.request
    with urllib.request.urlopen("http://127.0.0.1:3100/api/companies", timeout=5) as r:
        company_id = json.loads(r.read())[0]["id"]
    with urllib.request.urlopen(f"http://127.0.0.1:3100/api/companies/{company_id}/agents", timeout=5) as r:
        for a in json.loads(r.read()):
            AGENT_NAMES[a["id"]] = a.get("name", "?")
except Exception:
    pass

VAR_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def find_vars(mcp_servers):
    """Walk every inline env value, pull out ${VAR} references we need to forward."""
    found = set()
    for spec in mcp_servers.values():
        for v in (spec.get("env") or {}).values():
            if isinstance(v, str):
                for m in VAR_PATTERN.finditer(v):
                    found.add(m.group(1))
    return sorted(found)


def run(cmd, **kwargs):
    r = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if r.returncode != 0:
        raise RuntimeError(f"CMD FAIL: {' '.join(cmd) if isinstance(cmd, list) else cmd}\nstderr: {r.stderr}")
    return r


def sudo_install(src_path, dst_path, owner="root:root", mode="644"):
    u, g = owner.split(":")
    run(["sudo", "install", "-o", u, "-g", g, "-m", mode, src_path, dst_path])


def sudo_write(dst_path, content, owner="root:root", mode="644"):
    with tempfile.NamedTemporaryFile("w", delete=False, dir="/tmp", suffix=".json") as f:
        f.write(content)
        tmp = f.name
    try:
        sudo_install(tmp, dst_path, owner=owner, mode=mode)
    finally:
        os.unlink(tmp)


def already_migrated(mcp_path: Path) -> bool:
    """True if the workspace's .mcp.json is already a gateway-only single-entry file."""
    try:
        src = subprocess.run(["sudo", "cat", str(mcp_path)], capture_output=True, text=True, check=True).stdout
        doc = json.loads(src)
        servers = doc.get("mcpServers", {})
        return list(servers.keys()) == ["gw"]
    except Exception:
        return False


def main():
    dirs = sorted(p for p in os.listdir(WORKSPACES) if (WORKSPACES / p / ".mcp.json").exists())
    candidates = [d for d in dirs if d not in SKIP_IDS and not already_migrated(WORKSPACES / d / ".mcp.json")]

    print(f"Found {len(candidates)} agents to migrate")
    for aid in candidates:
        print(f"  {aid[:8]}  {AGENT_NAMES.get(aid, '?')}")
    print()

    run(["sudo", "mkdir", "-p", str(GATEWAY_CONFIG_DIR)])
    run(["sudo", "chmod", "755", str(GATEWAY_CONFIG_DIR)])

    for aid in candidates:
        name = AGENT_NAMES.get(aid, "?")
        ws = WORKSPACES / aid
        mcp_path = ws / ".mcp.json"
        src = subprocess.run(["sudo", "cat", str(mcp_path)], capture_output=True, text=True, check=True).stdout
        config = json.loads(src)
        mcp_servers = config.get("mcpServers", {})
        if not mcp_servers:
            print(f"SKIP  {name:<16} (empty mcpServers)")
            continue

        forward_vars = find_vars(mcp_servers)
        slug = name.lower().replace(" ", "-")

        gw_config = {
            "onCollision": "fail",
            "prefixTools": True,
            "mcpServers": mcp_servers,
        }
        gw_config_path = GATEWAY_CONFIG_DIR / f"{slug}.json"

        gw_env = {"MCP_GATEWAY_CONFIG": str(gw_config_path)}
        for v in forward_vars:
            gw_env[v] = f"${{{v}}}"

        new_mcp = {
            "mcpServers": {
                "gw": {
                    "command": "node",
                    "args": [GATEWAY_BIN],
                    "env": gw_env,
                }
            }
        }

        sudo_write(str(gw_config_path), json.dumps(gw_config, indent=2) + "\n", owner="root:root", mode="644")
        backup_path = str(mcp_path) + f".bak-pregateway-{STAMP}"
        run(["sudo", "cp", str(mcp_path), backup_path])
        sudo_write(str(mcp_path), json.dumps(new_mcp, indent=2) + "\n", owner="paperclip:paperclip", mode="644")

        child_names = ", ".join(sorted(mcp_servers.keys()))
        forwarded = ", ".join(forward_vars) if forward_vars else "(none)"
        print(f"OK    {name:<16} slug={slug:<16} children={len(mcp_servers)} forward={forwarded}")
        print(f"      -> {gw_config_path}")
        print(f"      -> {mcp_path}")
        print(f"      children: {child_names}")
        print(f"      backup:   {backup_path}")

    print("\nAll writes complete.")


if __name__ == "__main__":
    main()
