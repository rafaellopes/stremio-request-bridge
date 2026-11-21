import { createHash } from 'node:crypto';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.problems = problems;
  }
}

const int = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
};

const bool = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

const stripSlash = (url) => url.replace(/\/+$/, '');

function arrSection(env, prefix) {
  const url = env[`${prefix}_URL`];
  const apiKey = env[`${prefix}_API_KEY`];
  if (!url && !apiKey) return null;
  return {
    url: url ? stripSlash(url) : url,
    apiKey,
    rootFolder: env[`${prefix}_ROOT_FOLDER`] || undefined,
    qualityProfile: env[`${prefix}_QUALITY_PROFILE`] || undefined,
  };
}

// Reads and validates everything from environment variables. Throws ConfigError listing every problem at once.
export function loadConfig(env = process.env) {
  const problems = [];
  const radarr = arrSection(env, 'RADARR');
  const sonarr = arrSection(env, 'SONARR');

  for (const [name, section] of [['RADARR', radarr], ['SONARR', sonarr]]) {
    if (!section) continue;
    if (!section.url) problems.push(`${name}_URL is required when ${name}_API_KEY is set`);
    if (!section.apiKey) problems.push(`${name}_API_KEY is required when ${name}_URL is set`);
  }
  if (!radarr && !sonarr) problems.push('configure at least one of Radarr (RADARR_URL, RADARR_API_KEY) or Sonarr (SONARR_URL, SONARR_API_KEY)');

  const token = env.ACCESS_TOKEN || '';
  if (token.length < 16) problems.push('ACCESS_TOKEN must be at least 16 characters (generate one with: npm run gen-token)');
  if (!/^[A-Za-z0-9_-]+$/.test(token) && token) problems.push('ACCESS_TOKEN may only contain letters, digits, "-" and "_" (it is part of the URL)');

  const publicUrl = env.PUBLIC_URL ? stripSlash(env.PUBLIC_URL) : '';
  if (!/^https?:\/\//.test(publicUrl)) problems.push('PUBLIC_URL must be the address your players use to reach this addon, e.g. https://addon.example.com');

  const locale = env.LOCALE || 'en';
  if (!['en', 'pt'].includes(locale)) problems.push('LOCALE must be "en" or "pt"');

  const port = int(env.PORT, 7000);
  const rateLimitPerMinute = int(env.RATE_LIMIT_PER_MINUTE, 20);
  const globalLimitPerHour = int(env.GLOBAL_LIMIT_PER_HOUR, 60);
  for (const [name, value] of [['PORT', port], ['RATE_LIMIT_PER_MINUTE', rateLimitPerMinute], ['GLOBAL_LIMIT_PER_HOUR', globalLimitPerHour], ['FOLLOW_UP_MS', int(env.FOLLOW_UP_MS, 90_000)]]) {
    if (Number.isNaN(value)) problems.push(`${name} must be a non-negative integer`);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    token,
    tokenDigest: createHash('sha256').update(token).digest(),
    trustProxy: bool(env.TRUST_PROXY),
    locale,
    addonName: env.ADDON_NAME || 'Request Bridge',
    sourceName: env.SOURCE_NAME || 'Request',
    doneHint: env.DONE_HINT || undefined,
    minimumAvailability: env.MIN_AVAILABILITY || 'released',
    allowDelete: bool(env.ALLOW_DELETE),
    // After a request, check back later and tell the user when nothing was found (instead of staying on "requested").
    followUp: env.FOLLOW_UP === undefined || env.FOLLOW_UP === '' ? true : bool(env.FOLLOW_UP),
    followUpMs: int(env.FOLLOW_UP_MS, 90_000),
    rateLimitPerMinute,
    globalLimitPerHour,
    radarr,
    sonarr,
    // Sonarr loads episodes asynchronously after a series is added; these control how long we wait for them.
    seriesSettleMs: int(env.SERIES_SETTLE_MS, 4000),
    seriesPollMs: int(env.SERIES_POLL_MS, 1500),
  };
}
