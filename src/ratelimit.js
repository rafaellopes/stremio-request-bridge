// Sliding-window limiter. limit = 0 disables it.
export class RateLimiter {
  constructor(limit, windowMs, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  // Returns true if this hit is allowed (and records it).
  allow(key) {
    if (!this.limit) return true;
    const t = this.now();
    const recent = (this.hits.get(key) || []).filter((ts) => t - ts < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) this.prune(t);
    return true;
  }

  prune(t = this.now()) {
    for (const [key, list] of this.hits) {
      if (!list.some((ts) => t - ts < this.windowMs)) this.hits.delete(key);
    }
  }
}
