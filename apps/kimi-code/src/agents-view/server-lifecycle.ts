/**
 * Server lifecycle for the agents view — discover the running kap-server
 * instance that shares this CLI's home directory, and read its auth token.
 *
 * Discovery reuses `@moonshot-ai/kap-server`'s instance registry read side:
 * instance files under `<home>/server/instances/*.json` are probed with
 * `kill(pid, 0)`, dead-pid files are swept, and the longest-running live
 * instance wins. `resolveAgentsServer` builds on it: attach to that live
 * instance (behind a same-version gate), or embed a kap-server in-process
 * when none is running.
 */

import { readFileSync } from 'node:fs';

import {
  getLiveServerInstance,
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
 * Resolve the kap-server the agents view talks to: attach to the live instance
 * registered under `homeDir` when one exists, embed one in-process otherwise.
 *
 * Version gate: an attached server must run the same version as this CLI —
 * the wire protocol and home-dir state are version-coupled, so a mismatched
 * (or versionless, i.e. too-old) server is refused with a restart hint.
 */
export async function resolveAgentsServer(
  options: ResolveAgentsServerOptions,
): Promise<AgentsServer> {
  const { homeDir, identity, cliVersion } = options;

  const live = await discoverRunningServer(homeDir);
  if (live !== undefined) {
    if (live.version !== cliVersion) {
      throw new Error(
        live.version === undefined
          ? `a kap-server (pid ${live.pid}) older than the version gate is already running — restart it with this CLI (${cliVersion})`
          : `kap-server version mismatch: running ${live.version} (pid ${live.pid}), this CLI is ${cliVersion} — restart the running server with \`kimi web\` before opening the agents view`,
      );
    }
    // Same-machine premise: always talk to the server over loopback, whatever
    // host the instance file advertises.
    const baseUrl = `http://127.0.0.1:${live.port}`;
    return {
      mode: 'attached',
      baseUrl,
      token: readServerToken(homeDir),
      serverPid: live.pid,
      shutdown: async () => {},
    };
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
