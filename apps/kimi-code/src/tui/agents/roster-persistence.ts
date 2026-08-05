import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STATE_FILE = 'agents-view.json';

/**
 * The agents view's persisted state in `<homeDir>/agents-view.json`:
 * - `pins`: session ids the user pinned in the view.
 * - `sessions`: the view's roster scope — only sessions the view itself
 *   created (dispatch) or attached to (Enter on a row) are listed. Sessions
 *   from other clients (kimi-web, other terminals) never enter the view.
 *
 * A missing or corrupt file yields empty sets — loading must never throw.
 */
export interface AgentsViewState {
  readonly pins: Set<string>;
  readonly sessions: Set<string>;
}

function readIdSet(parsed: unknown, key: string): Set<string> {
  if (parsed === null || typeof parsed !== 'object') return new Set();
  const value = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((id): id is string => typeof id === 'string'));
}

export async function loadAgentsViewState(homeDir: string): Promise<AgentsViewState> {
  try {
    const raw = await readFile(join(homeDir, STATE_FILE), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return { pins: readIdSet(parsed, 'pins'), sessions: readIdSet(parsed, 'sessions') };
  } catch {
    return { pins: new Set(), sessions: new Set() };
  }
}

/** Atomic write: tmp file + rename, so a crash never leaves a torn JSON. */
export async function saveAgentsViewState(homeDir: string, state: AgentsViewState): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const file = join(homeDir, STATE_FILE);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const body = { pins: [...state.pins], sessions: [...state.sessions] };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
  await rename(tmp, file);
}
