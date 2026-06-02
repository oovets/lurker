// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// In node edition, a cell reports itself to the orchestrator (control plane) so
// the fleet knows it exists, where to reach it, and how loaded it is. This is
// the OUTBOUND half of node mode — the inbound control API (provision/
// deprovision) is routes/node.ts. On boot the cell registers; on an interval it
// re-registers, which the orchestrator treats as an idempotent upsert, so the
// same call doubles as a heartbeat and self-heals if the control plane restarts.
//
// Everything here fails soft: a node-edition cell with no orchestrator
// configured (e.g. local dev) simply does nothing, and an unreachable
// orchestrator never takes the cell down with it.

import { isNodeMode } from '../utils/edition.js';
import { APP_VERSION, USER_AGENT } from '../utils/userAgent.js';
import { countUsers } from '../db/users.js';
import * as systemLog from './systemLog.js';

interface OrchestratorConfig {
  /** Base URL of the control plane, e.g. http://orchestrator:8020. */
  url: string;
  /** This cell's stable name in the fleet. */
  name: string;
  /** How the orchestrator reaches THIS cell's /api/node API + proxies to it. */
  controlUrl: string;
  /** Soft cap on accounts this cell should hold (drives fill-then-pin). */
  capacity: number;
  /** Shared fleet secret — same value LURKER_NODE_SECRET authenticates the
   *  inbound node API with, reused as the bearer for this outbound report. */
  secret: string;
}

const DEFAULT_CAPACITY = 500;
const DEFAULT_INTERVAL_MS = 30_000;

// Returns config only when this instance is a node AND every required piece is
// present. Any gap → null → the client is a no-op.
export function readOrchestratorConfig(): OrchestratorConfig | null {
  if (!isNodeMode()) return null;
  const url = (process.env.LURKER_ORCHESTRATOR_URL || '').trim();
  const name = (process.env.LURKER_NODE_NAME || '').trim();
  const controlUrl = (process.env.LURKER_NODE_CONTROL_URL || '').trim();
  const secret = (process.env.LURKER_NODE_SECRET || '').trim();
  if (!url || !name || !controlUrl || !secret) return null;
  const capacityRaw = Number(process.env.LURKER_NODE_CAPACITY);
  const capacity = Number.isFinite(capacityRaw) && capacityRaw > 0 ? capacityRaw : DEFAULT_CAPACITY;
  return { url, name, controlUrl, capacity, secret };
}

/** The payload a cell advertises: identity + current load. */
export function buildRegistration(cfg: OrchestratorConfig): {
  name: string;
  control_url: string;
  capacity: number;
  version: string;
  user_count: number;
} {
  return {
    name: cfg.name,
    control_url: cfg.controlUrl,
    capacity: cfg.capacity,
    version: APP_VERSION,
    user_count: countUsers(),
  };
}

// POST the cell's identity + load to the orchestrator. Returns true on a 2xx,
// false on any non-2xx or network error — never throws.
export async function reportToOrchestrator(cfg: OrchestratorConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/_cp/cells/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.secret}`,
        // Identify these calls in control-plane logs, same as our other
        // outbound HTTP (upload providers).
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(buildRegistration(cfg)),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

// Register on boot, then re-register on an interval. No-op when not a configured
// node, so it's safe to call unconditionally at startup.
export function startOrchestratorClient(intervalMs = DEFAULT_INTERVAL_MS): void {
  // Idempotent: clear any prior interval first so a double-start (re-init path,
  // tests, future refactors) can't leak timers or run concurrent heartbeats.
  stopOrchestratorClient();
  const cfg = readOrchestratorConfig();
  if (!cfg) return;
  const tick = async (): Promise<void> => {
    const ok = await reportToOrchestrator(cfg);
    if (!ok) {
      systemLog.log({
        scope: 'node',
        level: 'warn',
        text: `failed to report to orchestrator at ${cfg.url} (unreachable or non-2xx) — will retry`,
      });
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  systemLog.log({
    scope: 'node',
    text: `reporting to orchestrator at ${cfg.url} as "${cfg.name}"`,
  });
}

export function stopOrchestratorClient(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
