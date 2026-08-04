/**
 * Server lifecycle for the agents view — discover the running kap-server
 * instance that shares this CLI's home directory, and read its auth token.
 *
 * Discovery reuses `@moonshot-ai/kap-server`'s instance registry read side:
 * instance files under `<home>/server/instances/*.json` are probed with
 * `kill(pid, 0)`, dead-pid files are swept, and the longest-running live
 * instance wins.
 */

import { readFileSync } from 'node:fs';

import { getLiveServerInstance, serverTokenPath } from '@moonshot-ai/kap-server';

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
