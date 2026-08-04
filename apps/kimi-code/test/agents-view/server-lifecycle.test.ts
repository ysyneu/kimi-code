import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverRunningServer } from '#/agents-view/server-lifecycle';

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
