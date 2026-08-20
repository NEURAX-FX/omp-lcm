import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveOptions } from '../options.js';
import type { OpencodeLcmOptions } from '../types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // A missing or malformed config must never block session startup.
    return undefined;
  }
}

/** Recursive merge so a project file overriding one nested key does not drop the
 *  user file's siblings under the same object. */
function mergeDeep(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    const overlayObject = asRecord(value);
    const baseObject = asRecord(result[key]);
    result[key] = overlayObject && baseObject ? mergeDeep(baseObject, overlayObject) : value;
  }

  return result;
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return true;
}

function envOverlay(): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};

  const freshTail = envInt('OMP_LCM_FRESH_TAIL_MESSAGES');
  if (freshTail !== undefined) overlay.freshTailMessages = freshTail;

  const minMessages = envInt('OMP_LCM_MIN_MESSAGES_FOR_TRANSFORM');
  if (minMessages !== undefined) overlay.minMessagesForTransform = minMessages;

  const summaryBudget = envInt('OMP_LCM_SUMMARY_CHAR_BUDGET');
  if (summaryBudget !== undefined) overlay.summaryCharBudget = summaryBudget;

  const retrieval = envBool('OMP_LCM_AUTOMATIC_RETRIEVAL');
  if (retrieval !== undefined) overlay.automaticRetrieval = { enabled: retrieval };

  const systemHint = envBool('OMP_LCM_SYSTEM_HINT');
  if (systemHint !== undefined) overlay.systemHint = systemHint;

  return overlay;
}

/**
 * Load options for a session.
 *
 * omp has no per-extension config channel — `SettingPath` is closed over a fixed
 * schema (settings-schema.ts:5590), so an `lcm.*` key is not a legal setting
 * path. Configuration is therefore layered by hand: built-in defaults, then the
 * user file, then the project file, then env. `resolveOptions` performs all
 * normalization and clamping, including of malformed values.
 */
export function loadOptions(cwd: string, agentDir?: string): OpencodeLcmOptions {
  const userDir = agentDir ?? path.join(homedir(), '.omp', 'agent');
  const layers = [
    readJsonObject(path.join(userDir, 'lcm.json')),
    readJsonObject(path.join(cwd, '.omp', 'lcm.json')),
    envOverlay(),
  ];

  let raw: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer) raw = mergeDeep(raw, layer);
  }

  return resolveOptions(raw);
}
