# Ops

Operational tooling used to roll `@devli13/mcp-gateway` out to a production
multi-agent Paperclip deployment. Kept in the repo as a reference for similar
rollouts or for rolling back.

## Files

- `migrate-agents-to-gateway.py` — mass-migrates existing Paperclip agents from
  direct-MCP `.mcp.json` configs to per-agent gateway configs stored in
  `/etc/paperclip/mcp-gateway/<slug>.json` (root-owned). Handles `${VAR}`
  forwarding automatically by scanning each agent's inline `env` values. Skips
  workspaces whose `.mcp.json` already points at the gateway. Per-agent backup
  is written to the workspace as `.mcp.json.bak-pregateway-<timestamp>` for
  one-line rollback.

## Deployment pattern

1. Install the gateway on the host (`git clone` + `npm install` +
   `npm test`).
2. Create the root-owned config directory:
   ```
   sudo mkdir -p /etc/paperclip/mcp-gateway
   sudo chmod 755 /etc/paperclip/mcp-gateway
   ```
3. Run the migration script as root:
   ```
   sudo python3 ops/migrate-agents-to-gateway.py
   ```
4. Verify each workspace loads the gateway:
   ```
   sudo -u <user> -E bash -c "cd <workspace> && claude mcp list"
   # expect: gw: node .../server.js - ✓ Connected
   ```
5. (Optional) if you were previously using a `.mcp.json` ↔
   `.gemini/settings.json` sync watcher, this rollout makes it redundant: every
   workspace's `.mcp.json` is now a one-line entry pointing at the gateway.

## Security model — per-agent scoped configs

Each agent gets its own gateway config file at
`/etc/paperclip/mcp-gateway/<slug>.json`. Files are root-owned `644`. The
paperclip user can read but cannot write or rename. A prompt-injected agent
cannot invoke tools from an MCP that is not loaded in its own gateway process,
and cannot add MCPs to its own gateway config.

## Health monitoring

The gateway exposes a built-in `gateway_health` tool. The companion helper
`scripts/health-check.js` provides a standalone way to query that tool without
going through an MCP client — it's what a cron-style monitor (e.g. Paperclip's
`paperclip-mcp-healthcheck.sh` systemd timer) uses to drill into each agent's
gateway and surface per-child status for edge-triggered alerts.

## Rollback

Per agent, restore the backed-up `.mcp.json` and remove the per-agent gateway
config:

```
AGENT_WS=/home/paperclip/.paperclip/instances/default/workspaces/<uuid>
sudo install -o paperclip -g paperclip -m 644 \
  $AGENT_WS/.mcp.json.bak-pregateway-<ts> $AGENT_WS/.mcp.json
sudo rm /etc/paperclip/mcp-gateway/<slug>.json
```

If you had the sync watcher in place before migrating, re-enable it before
rolling back more than a single agent — otherwise `.gemini/settings.json`
falls out of sync with the restored `.mcp.json`.
