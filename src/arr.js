// Minimal client for the Radarr v3+ / Sonarr v3+ REST API (same shape for both).
export class Arr {
  constructor({ url, apiKey }, fetchImpl = fetch) {
    this.url = url;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async call(method, path, body) {
    const res = await this.fetch(`${this.url}/api/v3${path}`, {
      method,
      headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  get(path) { return this.call('GET', path); }
  post(path, body) { return this.call('POST', path, body); }
  put(path, body) { return this.call('PUT', path, body); }
}
