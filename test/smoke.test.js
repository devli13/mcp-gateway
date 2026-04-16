import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server.js');

function jsonRpcRequest(proc, request) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for JSON-RPC response')), 10000);
    const onData = (chunk) => {
      buf += chunk.toString();
      // Each JSON-RPC frame is delimited by a newline in stdio transport
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === request.id) {
            clearTimeout(timeout);
            proc.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // partial frame, keep buffering
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify(request) + '\n');
  });
}

describe('@devli13/mcp-gateway smoke tests', () => {
  it('exits with clear error when no config is found', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    try {
      const proc = spawn('node', [SERVER], {
        env: {
          PATH: process.env.PATH,
          MCP_GATEWAY_CONFIG: join(tmpDir, 'nonexistent.json'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      const code = await new Promise((resolve) => proc.on('close', resolve));
      assert.notEqual(code, 0, 'Should exit non-zero without config');
      assert.match(stderr, /Config not found/, 'Error should mention missing config');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('starts with empty config and exposes only gateway_health tool', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }));
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });

      // initialize
      await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });

      const toolsResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      assert.ok(toolsResp.result, 'tools/list should return result');
      assert.ok(Array.isArray(toolsResp.result.tools), 'tools should be an array');
      assert.equal(toolsResp.result.tools.length, 1, 'empty config -> only gateway_health');
      assert.equal(toolsResp.result.tools[0].name, 'gateway_health');

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('aggregates a real child MCP and forwards tool calls', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    const mockPath = join(__dirname, 'fixtures', 'mock-mcp.js');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          mock: { command: 'node', args: [mockPath] },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });

      await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });

      const toolsResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const names = toolsResp.result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['gateway_health', 'mock_echo'], 'should expose both child tool and built-in');

      const mockTool = toolsResp.result.tools.find((t) => t.name === 'mock_echo');
      assert.equal(mockTool.description, 'Echo back the input text. Test fixture only.');
      assert.deepEqual(mockTool.inputSchema, {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      }, 'tool schema should pass through losslessly');

      const callResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'mock_echo', arguments: { text: 'hello world' } },
      });

      assert.ok(callResp.result, 'tools/call should return result');
      assert.equal(callResp.result.content[0].text, 'echo: hello world');

      const healthResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'gateway_health', arguments: {} },
      });
      const healthJson = JSON.parse(healthResp.result.content[0].text);
      assert.equal(healthJson.length, 1);
      assert.equal(healthJson[0].name, 'mock');
      assert.equal(healthJson[0].degraded, false);
      assert.equal(healthJson[0].tools, 1);

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('marks a child as degraded when its command does not exist', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          broken: { command: '/nonexistent/path/to/binary', args: [] },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });

      await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });

      const healthResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'gateway_health', arguments: {} },
      });
      const healthJson = JSON.parse(healthResp.result.content[0].text);
      assert.equal(healthJson.length, 1);
      assert.equal(healthJson[0].name, 'broken');
      assert.equal(healthJson[0].degraded, true);
      assert.ok(healthJson[0].error, 'should record an error message');

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses to start on tool name collision (default onCollision=fail)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    const mockA = join(__dirname, 'fixtures', 'mock-mcp.js');
    const mockB = join(__dirname, 'fixtures', 'echo-twin-mcp.js');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          a: { command: 'node', args: [mockA] },
          b: { command: 'node', args: [mockB] },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      const code = await new Promise((resolve) => proc.on('close', resolve));
      assert.notEqual(code, 0, 'gateway should exit non-zero on collision');
      assert.match(stderr, /collision/i, 'error should mention collision');
      assert.match(stderr, /mock_echo/, 'error should name the colliding tool');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('starts with onCollision=first-wins and routes to the first child', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    const mockA = join(__dirname, 'fixtures', 'mock-mcp.js');
    const mockB = join(__dirname, 'fixtures', 'echo-twin-mcp.js');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        onCollision: 'first-wins',
        mcpServers: {
          a: { command: 'node', args: [mockA] },
          b: { command: 'node', args: [mockB] },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });

      await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });

      const callResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'mock_echo', arguments: { text: 'hi' } },
      });
      assert.equal(callResp.result.content[0].text, 'echo: hi', 'first-seen child (mock-mcp) should win');

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves ${VAR} interpolation in child env from the gateway process env', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    const envReader = join(__dirname, 'fixtures', 'env-reader-mcp.js');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          reader: {
            command: 'node',
            args: [envReader],
            env: {
              RESOLVED_SECRET: '${GATEWAY_TEST_SECRET}',
              LITERAL_VALUE: 'plain-text',
            },
          },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: {
          PATH: process.env.PATH,
          MCP_GATEWAY_CONFIG: cfgPath,
          GATEWAY_TEST_SECRET: 'resolved-from-parent-env',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });
      await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });
      const resolved = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'read_env', arguments: { key: 'RESOLVED_SECRET' } },
      });
      assert.equal(resolved.result.content[0].text, 'resolved-from-parent-env');

      const literal = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'read_env', arguments: { key: 'LITERAL_VALUE' } },
      });
      assert.equal(literal.result.content[0].text, 'plain-text');

      // Parent env vars NOT listed in the child env spec must not leak through.
      const leaked = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'read_env', arguments: { key: 'GATEWAY_TEST_SECRET' } },
      });
      assert.equal(leaked.result.content[0].text, '<undefined>',
        'parent env must not leak into child unless explicitly referenced');

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hides tools listed in disabled_tools and rejects direct calls', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    const mock = join(__dirname, 'fixtures', 'mock-mcp.js');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          muzzled: {
            command: 'node',
            args: [mock],
            disabled_tools: ['mock_echo'],
          },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });
      await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });
      const toolsResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 2, method: 'tools/list',
      });
      const names = toolsResp.result.tools.map((t) => t.name);
      assert.ok(!names.includes('mock_echo'), 'disabled tool must not appear in tools/list');
      assert.ok(names.includes('gateway_health'), 'gateway_health still available');

      const callResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'mock_echo', arguments: { text: 'should fail' } },
      });
      assert.ok(callResp.error || callResp.result?.isError,
        'direct call to disabled tool must return an error');

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prefixes tool names with child-name when prefixTools=true', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    const mockA = join(__dirname, 'fixtures', 'mock-mcp.js');
    const mockB = join(__dirname, 'fixtures', 'echo-twin-mcp.js');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        prefixTools: true,
        mcpServers: {
          alpha: { command: 'node', args: [mockA] },
          beta: { command: 'node', args: [mockB] },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });
      await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });
      const toolsResp = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 2, method: 'tools/list',
      });
      const names = toolsResp.result.tools.map((t) => t.name).sort();
      assert.deepEqual(
        names,
        ['alpha__mock_echo', 'beta__mock_echo', 'gateway_health'],
        'both echos exposed under distinct prefixed names'
      );

      const a = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'alpha__mock_echo', arguments: { text: 'hi' } },
      });
      assert.equal(a.result.content[0].text, 'echo: hi', 'alpha routed to mock-mcp');

      const b = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'beta__mock_echo', arguments: { text: 'hi' } },
      });
      assert.equal(b.result.content[0].text, 'twin: hi', 'beta routed to echo-twin-mcp');

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('isolates failures when a child crashes mid-session', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-gw-'));
    const cfgPath = join(tmpDir, 'gateway.config.json');
    const crashy = join(__dirname, 'fixtures', 'crashy-mcp.js');
    const mock = join(__dirname, 'fixtures', 'mock-mcp.js');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          crashy: { command: 'node', args: [crashy] },
          stable: { command: 'node', args: [mock] },
        },
      })
    );
    try {
      const proc = spawn('node', [SERVER], {
        env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: cfgPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpDir,
      });

      await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });

      // Confirm both alive at start
      const ping = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'crashy_ping', arguments: {} },
      });
      assert.equal(ping.result.content[0].text, 'pong');

      // Trigger the crash; the response itself may or may not arrive.
      try {
        await jsonRpcRequest(proc, {
          jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'crash_now', arguments: {} },
        });
      } catch {
        /* response may be lost — that's fine */
      }

      // Give the gateway a moment to detect the dead child.
      await new Promise((r) => setTimeout(r, 200));

      // The other child must still work.
      const stableCall = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'mock_echo', arguments: { text: 'still here' } },
      });
      assert.equal(stableCall.result.content[0].text, 'echo: still here');

      // The crashed child should now report degraded.
      const health = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'gateway_health', arguments: {} },
      });
      const healthJson = JSON.parse(health.result.content[0].text);
      const crashyHealth = healthJson.find((c) => c.name === 'crashy');
      const stableHealth = healthJson.find((c) => c.name === 'stable');
      assert.equal(crashyHealth.degraded, true, 'crashy child must be marked degraded after crash');
      assert.equal(stableHealth.degraded, false, 'stable child must remain healthy');

      // Calling the dead child's tool should return a clean error, not hang.
      const deadCall = await jsonRpcRequest(proc, {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'crashy_ping', arguments: {} },
      });
      // crashy_ping was wiped from the tool map when the child went degraded,
      // so the response is an error (either "Tool not found" or "unavailable").
      assert.ok(deadCall.error || deadCall.result?.isError,
        'dead-child tool call must return an error, not a successful result');

      proc.kill();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
