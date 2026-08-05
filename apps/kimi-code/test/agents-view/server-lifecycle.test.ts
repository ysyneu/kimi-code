import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countRunningSessions,
  discoverRunningServer,
  readServerToken,
  resolveAgentsServer,
} from '#/agents-view/server-lifecycle';

/** Max signed-32 pid; the kernel never allocates it, so `kill(pid, 0)` → ESRCH. */
const DEAD_PID = 0x7fffffff;

describe('discoverRunningServer', () => {
  let home: string;
  let instancesDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-agents-discovery-'));
    instancesDir = join(home, 'server', 'instances');
    await mkdir(instancesDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns undefined when no instances dir/files exist', async () => {
    await rm(instancesDir, { recursive: true, force: true });
    await expect(discoverRunningServer(home)).resolves.toBeUndefined();
  });

  it('returns the live instance and sweeps dead-pid files', async () => {
    const live = {
      server_id: 'live1',
      pid: process.pid,
      host: '127.0.0.1',
      port: 58627,
      started_at: Date.now() - 60_000,
      heartbeat_at: Date.now(),
      host_version: '0.30.0',
    };
    const dead = {
      server_id: 'dead1',
      pid: DEAD_PID,
      host: '127.0.0.1',
      port: 1,
      started_at: Date.now() - 30_000,
      heartbeat_at: Date.now(),
    };
    await writeFile(join(instancesDir, 'live1.json'), JSON.stringify(live));
    await writeFile(join(instancesDir, 'dead1.json'), JSON.stringify(dead));

    const found = await discoverRunningServer(home);
    expect(found?.serverId).toBe('live1');
    expect(found?.port).toBe(58627);
    expect(found?.version).toBe('0.30.0');
    // dead file swept:
    const { access } = await import('node:fs/promises');
    await expect(access(join(instancesDir, 'dead1.json'))).rejects.toThrow();
  });

  it('prefers the longest-running instance when several are alive', async () => {
    const older = {
      server_id: 'a',
      pid: process.pid,
      host: '127.0.0.1',
      port: 1,
      started_at: 1000,
      heartbeat_at: 2000,
    };
    const newer = {
      server_id: 'b',
      pid: process.pid,
      host: '127.0.0.1',
      port: 2,
      started_at: 5000,
      heartbeat_at: 6000,
    };
    await writeFile(join(instancesDir, 'a.json'), JSON.stringify(older));
    await writeFile(join(instancesDir, 'b.json'), JSON.stringify(newer));
    const found = await discoverRunningServer(home);
    expect(found?.serverId).toBe('a');
  });
});

const IDENTITY = { productName: 'test-cli', version: '0.0.0-test', platform: 'test' } as const;

describe('readServerToken', () => {
  it('throws a helpful error when the token file is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-agents-token-'));
    try {
      expect(() => readServerToken(home)).toThrow(/kap-server token not found.*kimi web/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('resolveAgentsServer', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-agents-resolve-'));
  });

  afterEach(async () => {
    // kap-server's `close()` returns while its fire-and-forget model-catalog
    // refresh can still be mid-write under `<home>/cache/` — retry the sweep.
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('embeds a server when none is running', async () => {
    const server = await resolveAgentsServer({
      homeDir: home,
      identity: IDENTITY,
      cliVersion: IDENTITY.version,
    });
    expect(server.mode).toBe('embedded');
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.token).toBeTruthy();
    // the embedded server answers requests:
    const res = await fetch(`${server.baseUrl}/api/v1/healthz`);
    expect(res.ok).toBe(true);
    await server.shutdown();
  });

  it('attaches to a running server instead of embedding a second one', async () => {
    const first = await resolveAgentsServer({
      homeDir: home,
      identity: IDENTITY,
      cliVersion: IDENTITY.version,
    });
    expect(first.mode).toBe('embedded');
    const second = await resolveAgentsServer({
      homeDir: home,
      identity: IDENTITY,
      cliVersion: IDENTITY.version,
    });
    expect(second.mode).toBe('attached');
    expect(second.baseUrl).toBe(first.baseUrl);
    // attached shutdown must NOT kill the server:
    await second.shutdown();
    const res = await fetch(`${first.baseUrl}/api/v1/healthz`);
    expect(res.ok).toBe(true);
    await first.shutdown();
  });

  it('refuses an external server whose version differs', async () => {
    const first = await resolveAgentsServer({
      homeDir: home,
      identity: IDENTITY,
      cliVersion: IDENTITY.version,
    });
    await expect(
      resolveAgentsServer({ homeDir: home, identity: IDENTITY, cliVersion: '9.9.9-different' }),
    ).rejects.toThrow(/9\.9\.9-different/);
    await first.shutdown();
  });

  it('falls back to embedded when the registered pid is alive but the port is dead', async () => {
    // An orphaned server can hold a live pid while its HTTP surface is gone
    // (half-shutdown host). Attaching there crashes with ECONNREFUSED — the
    // probe must send the view down the embedded path instead.
    const instancesDir = join(home, 'server', 'instances');
    await mkdir(instancesDir, { recursive: true });
    await writeFile(
      join(instancesDir, 'stale.json'),
      JSON.stringify({
        server_id: 'stale',
        pid: process.pid, // alive, but nothing listens on port 1
        host: '127.0.0.1',
        port: 1,
        started_at: Date.now(),
        heartbeat_at: Date.now(),
        host_version: IDENTITY.version,
      }),
    );
    await writeFile(join(home, 'server.token'), 'stale-token', { mode: 0o600 });

    const server = await resolveAgentsServer({
      homeDir: home,
      identity: IDENTITY,
      cliVersion: IDENTITY.version,
    });
    expect(server.mode).toBe('embedded');
    const res = await fetch(`${server.baseUrl}/api/v1/healthz`);
    expect(res.ok).toBe(true);
    await server.shutdown();
  });

  it('refuses a versionless (pre-version-gate) running server', async () => {
    const instancesDir = join(home, 'server', 'instances');
    await mkdir(instancesDir, { recursive: true });
    await writeFile(
      join(instancesDir, 'old.json'),
      JSON.stringify({
        server_id: 'old',
        pid: process.pid,
        host: '127.0.0.1',
        port: 1,
        started_at: Date.now(),
        heartbeat_at: Date.now(),
        // no host_version — written by a server older than the version gate
      }),
    );
    await expect(
      resolveAgentsServer({ homeDir: home, identity: IDENTITY, cliVersion: IDENTITY.version }),
    ).rejects.toThrow(/older than the version gate/);
  });
});

describe('countRunningSessions', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-agents-count-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('counts busy sessions over the wire', async () => {
    const server = await resolveAgentsServer({
      homeDir: home,
      identity: IDENTITY,
      cliVersion: IDENTITY.version,
    });
    // no sessions yet:
    await expect(countRunningSessions(server)).resolves.toBe(0);
    // create one (idle → not busy; a genuinely busy session needs a running
    // turn, which needs a provider — the busy filter itself is kap-server's
    // own tested behavior):
    await fetch(`${server.baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    await expect(countRunningSessions(server)).resolves.toBe(0);
    await server.shutdown();
  });
});
