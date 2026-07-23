/**
 * Map-free live poller for cards/sheets. Reuses the shared tiered `getLiveBuses`
 * cascade (native → extension → relay → server → proxy, spec §5.2). The map's own
 * 3D tracking (`buses.ts`) is separate; this is only for a compact "N en vivo"
 * readout where no WebGL layer is wanted.
 */

import { api, type LiveBusResult } from '@shared/services/api';
import { getLiveNameCandidates } from '@shared/data/routeCatalog';
import type { RouteListItem } from '@shared/types/transmilenio';

/** Destination-name candidates for a route's live query, cached on the route. */
export function liveNameCandidates(route: RouteListItem): string[] {
  if (!route.liveNameCandidates || route.liveNameCandidates.length === 0) {
    route.liveNameCandidates = getLiveNameCandidates(route);
  }
  return route.liveNameCandidates;
}

export function pollLiveOnce(route: RouteListItem, fresh = false): Promise<LiveBusResult> {
  const names = liveNameCandidates(route);
  return api.getLiveBuses(route.code, names[0] || route.name, route.type, names, { fresh });
}

export class LivePoller {
  private timer: number | null = null;
  private inFlight = false;
  constructor(
    private readonly route: RouteListItem,
    private readonly onUpdate: (result: LiveBusResult | 'loading') => void,
    private readonly intervalMs = 15_000
  ) {}

  start(): void {
    this.stop();
    this.tick();
    this.timer = window.setInterval(() => this.tick(), this.intervalMs);
  }

  private async tick(fresh = false): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    if (this.timer === null) this.onUpdate('loading'); // first call, before interval set
    try {
      const res = await pollLiveOnce(this.route, fresh);
      this.onUpdate(res);
    } finally {
      this.inFlight = false;
    }
  }

  refresh(): void {
    this.tick(true); // user asked for new data — don't answer from the shared window
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
