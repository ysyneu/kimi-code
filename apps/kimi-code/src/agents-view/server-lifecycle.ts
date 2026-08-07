/**
 * Server lifecycle for the agents view — discover the running kap-server
 * instance that shares this CLI's home directory, and read its auth token.
 *
 * Discovery reuses `@moonshot-ai/kap-server`'s instance registry read side:
 * instance files under `<home>/server/instances/*.json` are probed with
 * `kill(pid, 0)`, dead-pid files are swept, and the live set comes back
 * sorted oldest-first. `resolveAgentsServer` builds on it: attach to the
 * first live instance that is both version-matched and reachable, or embed a
 * kap-server in-process when none qualifies.
 */

import { readFileSync } from 'node:fs';

import {
  getLiveServerInstance,
  listLiveServerInstances,
  serverTokenPath,
  startServer,
  type RunningServer,
} from '@moonshot-ai/kap-server';

/** A discovered running kap-server instance. */
export interface AgentsServerInstance {
  readonly serverId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly version?: string;
}

/**
 * Return the longest-running live kap-server instance under `homeDir`,
 * sweeping dead-pid instance files as a side effect. `undefined` when the
 * instances directory is missing or holds no live instance.
 */
export async function discoverRunningServer(
  homeDir: string,
): Promise<AgentsServerInstance | undefined> {
  const live = await getLiveServerInstance(homeDir);
  if (live === undefined) return undefined;
  return {
    serverId: live.serverId,
    pid: live.pid,
    host: live.host,
    port: live.port,
    version: live.serverVersion,
  };
}

/**
 * Read the kap-server bearer token from `<homeDir>/server.token` (read-only).
 * Throws when the file is missing, unreadable, or empty.
 */
export function readServerToken(homeDir: string): string {
  const path = serverTokenPath(homeDir);
  let token = '';
  try {
    token = readFileSync(path, 'utf8').trim();
  } catch {
    // fall through to the throw below
  }
  if (token === '') {
    throw new Error(`kap-server token not found at ${path} — start one with \`kimi web\``);
  }
  return token;
}

/** A kap-server in another process that this CLI attached to. */
export interface AttachedAgentsServer {
  readonly mode: 'attached';
  readonly baseUrl: string;
  readonly token: string;
  readonly serverPid: number;
  /** No-op: the external server outlives this CLI. */
  shutdown(): Promise<void>;
}

/** A kap-server embedded in this process. */
export interface EmbeddedAgentsServer {
  readonly mode: 'embedded';
  readonly baseUrl: string;
  readonly token: string;
  readonly running: RunningServer;
  shutdown(): Promise<void>;
}

export type AgentsServer = AttachedAgentsServer | EmbeddedAgentsServer;

export interface ResolveAgentsServerOptions {
  readonly homeDir: string;
  /** Host product identity handed to the embedded server's engine. */
  readonly identity: {
    readonly productName: string;
    readonly version: string;
    readonly platform: string;
  };
  /** This CLI's version — the version gate compares the running server against it. */
  readonly cliVersion: string;
}

/**
 * Resolve the kap-server the agents view talks to: attach to a live,
 * version-matched instance registered under `homeDir` when one exists, embed
 * one in-process otherwise.
 *
 * Version filter: the wire protocol and home-dir state are version-coupled,
 * so only an instance running this CLI's exact version is attach-worthy.
 * The instance registry is multi-instance by design (concurrent differently
 * versioned servers are the shipped norm, not an error) — every live
 * instance is scanned oldest-first for a version match; a mismatched (or
 * versionless, i.e. too-old) instance is simply skipped rather than failed
 * on, exactly like the no-live-instance case below.
 *
 * Liveness gate: a registered pid is not proof of service — an orphaned
 * server can hold a live pid while its HTTP surface is already gone (e.g. a
 * half-shutdown TUI host). Attaching to that used to crash the CLI with a
 * raw ECONNREFUSED, so each version-matched instance must answer a probe
 * request before we attach; an unreachable one is skipped like a version
 * mismatch.
 */
export async function resolveAgentsServer(
  options: ResolveAgentsServerOptions,
): Promise<AgentsServer> {
  const { homeDir, identity, cliVersion } = options;

  const versionMatched = (await listLiveServerInstances(homeDir)).filter(
    (instance) => instance.serverVersion === cliVersion,
  );
  if (versionMatched.length > 0) {
    // Same-machine premise: always talk to the server over loopback, whatever
    // host the instance file advertises.
    const token = readServerToken(homeDir);
    for (const instance of versionMatched) {
      const baseUrl = `http://127.0.0.1:${instance.port}`;
      if (await probeServer(baseUrl, token)) {
        return {
          mode: 'attached',
          baseUrl,
          token,
          serverPid: instance.pid,
          shutdown: async () => {},
        };
      }
    }
  }

  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logLevel: 'silent',
    hostIdentity: identity,
    // kap-server defaults the instance file's `host_version` to its own package
    // version; pin it to the CLI version instead so a second process's version
    // gate compares CLI against CLI.
    serverVersion: cliVersion,
  });
  return {
    mode: 'embedded',
    baseUrl: `http://127.0.0.1:${running.port}`,
    token: running.authTokenService.getToken(),
    running,
    shutdown: () => running.close(),
  };
}

/**
 * Cheap attach-worthiness probe: the session list endpoint answers with an
 * auth'd `fetch`. Any refusal — connection error, timeout, non-OK status —
 * means "do not attach", never a thrown error.
 */
async function probeServer(baseUrl: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/sessions?busy=true`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Count the server's busy sessions — the data source for the agents view's
 * exit confirmation ("N sessions still running"). Uses the session list
 * endpoint's server-side `busy` filter over plain fetch (this module stays
 * UI-free and SDK-free); the filter's correctness is kap-server's own tested
 * behavior.
 */
export async function countRunningSessions(server: AgentsServer): Promise<number> {
  const res = await fetch(`${server.baseUrl}/api/v1/sessions?busy=true`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  if (!res.ok) {
    throw new Error(`failed to count running sessions: HTTP ${res.status} from ${server.baseUrl}`);
  }
  const body = (await res.json()) as { data: { items: unknown[] } };
  return body.data.items.length;
}
