const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)
  ?? 'https://pp47lf5l5e.execute-api.eu-west-1.amazonaws.com';

export type ZoneName = 'bedsA' | 'bedsB' | 'polytunnel';

export interface SensorRow {
  ts: number;
  soilA1: number | null;
  soilA2: number | null;
  soilB1: number | null;
  soilB2: number | null;
  soilPoly: number | null;
  tempC: number | null;
  rh: number | null;
  battV: number | null;
}

export interface ValveEvent {
  ts: number;
  zone: ZoneName | null;
  action: 'open' | 'close' | null;
  // 'app'/'button' are current; 'manual'/'override' are legacy, normalised in the UI.
  source: 'auto' | 'app' | 'button' | 'manual' | 'override' | 'failclose' | null;
  durationSec: number | null;
}

export interface Config {
  soilThreshold: Record<ZoneName, number>;
  soilStop: Record<ZoneName, number>;
  rainSkipMm: number;
  overrideMinutes: number;
  wateringWindow: { startHour: number; endHour: number };
  freezeGuardC: number;
  dailyCapMin: number;
}

export interface DeviceStatus {
  mode: string;
  battV: number | null;
  fault: boolean;
  fw: string | null;
  lastSeenEpoch: number;
  online: boolean;
  valve: Record<ZoneName, { open: boolean }> | null;
}

export interface WeatherPoint {
  ts: number;
  tempC: number | null;
  rh: number | null;
  precipMm: number | null;
  weatherCode: number | null;
}

export interface Weather {
  current: { tempC: number; rh: number; precipMm: number; weatherCode: number } | null;
  forecast: WeatherPoint[];
  rainSum12h: number;
  fetchedAt: number;
}

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}

export const api = {
  status: () => get<DeviceStatus>('/status'),

  sensors: (from?: number, to?: number) =>
    get<{ items: SensorRow[] }>('/sensors', {
      ...(from != null ? { from: String(from) } : {}),
      ...(to != null ? { to: String(to) } : {}),
    }),

  valveHistory: (from?: number, to?: number) =>
    get<{ items: ValveEvent[] }>('/valve-history', {
      ...(from != null ? { from: String(from) } : {}),
      ...(to != null ? { to: String(to) } : {}),
    }),

  config: () => get<Config>('/config'),

  putConfig: (cfg: Partial<Config>) =>
    put<{ ok: boolean }>('/config', cfg),

  zoneSet: (zone: ZoneName, open: boolean) =>
    post<{ ok: boolean; untilEpoch?: number }>(`/zone/${zone}`, { open }),

  zoneSkipNext: (zone: ZoneName) =>
    post<{ ok: boolean }>(`/zone/${zone}/skip-next`),

  weather: () => get<Weather>('/weather'),
};
