import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PINS_FILE = 'agents-view.json';

/**
 * Reads the pinned session ids from `<homeDir>/agents-view.json`
 * (`{ "pins": string[] }`). A missing or corrupt file yields an empty set —
 * loading pins must never throw.
 */
export async function loadPins(homeDir: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(homeDir, PINS_FILE), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return new Set();
    const pins = (parsed as { pins?: unknown }).pins;
    if (!Array.isArray(pins)) return new Set();
    return new Set(pins.filter((pin): pin is string => typeof pin === 'string'));
  } catch {
    return new Set();
  }
}

/** Atomic write: tmp file + rename, so a crash never leaves a torn JSON. */
export async function savePins(homeDir: string, pins: ReadonlySet<string>): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const file = join(homeDir, PINS_FILE);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ pins: [...pins] }, null, 2)}\n`, 'utf-8');
  await rename(tmp, file);
}
