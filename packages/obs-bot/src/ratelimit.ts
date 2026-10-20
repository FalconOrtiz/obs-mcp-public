import type { Platform } from "./events.ts";

export type PlatformLimit = {
  capacity: number;
  perMs: number;
};

export const DEFAULT_REPLY_LIMITS: Record<Platform, PlatformLimit> = {
  twitch: { capacity: 20, perMs: 30_000 },
  youtube: { capacity: 10, perMs: 60_000 },
  kick: { capacity: 20, perMs: 30_000 },
  x: { capacity: 5, perMs: 15 * 60_000 },
};

export const DEFAULT_ACTION_LIMITS: Record<Platform, PlatformLimit> = {
  twitch: { capacity: 4, perMs: 30_000 },
  youtube: { capacity: 4, perMs: 30_000 },
  kick: { capacity: 4, perMs: 30_000 },
  x: { capacity: 2, perMs: 60_000 },
};

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly limits: Record<Platform, PlatformLimit>;

  constructor(limits: Record<Platform, PlatformLimit>) {
    this.limits = limits;
  }

  tryTake(platform: Platform, now = Date.now()): boolean {
    const limit = this.limits[platform];
    const current = this.buckets.get(platform) ?? { tokens: limit.capacity, updated: now };
    const elapsed = Math.max(0, now - current.updated);
    const refilled = Math.min(limit.capacity, current.tokens + (elapsed / limit.perMs) * limit.capacity);
    if (refilled < 1) {
      this.buckets.set(platform, { tokens: refilled, updated: now });
      return false;
    }
    this.buckets.set(platform, { tokens: refilled - 1, updated: now });
    return true;
  }
}
