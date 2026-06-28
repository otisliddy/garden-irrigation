import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, ComposedChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Brush,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../api';
import type { SensorRow, ValveEvent, Config, ZoneName } from '../api';

type Tab = 'moisture' | 'climate' | 'valves' | 'battery';
type Range = '6h' | '24h' | '7d' | '30d';

// ADC calibration: 1300 = fully submerged (100%), 3350 = dry in air (0%)
const ADC_WET = 1300;
const ADC_DRY = 3350;
function adcPct(adc: number | null | undefined): number | undefined {
  if (adc == null) return undefined;
  return Math.round(Math.max(0, Math.min(100, (ADC_DRY - adc) / (ADC_DRY - ADC_WET) * 100)));
}

interface Props {
  config: Config | null;
}

const RANGE_MS: Record<Range, number> = {
  '6h':  6  * 3600e3,
  '24h': 24 * 3600e3,
  '7d':  7  * 86400e3,
  '30d': 30 * 86400e3,
};

function fmtTs(ts: number, range: Range): string {
  const d = new Date(ts);
  if (range === '6h' || range === '24h')
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

// Round, evenly-spaced tick positions for a numeric time axis. Samples arrive at
// odd minutes (:03/:18/:33/:48), so we can't pick "nice" labels from the data —
// we generate clock-aligned boundaries (hours / days) within the data span and let
// recharts place them. Far fewer, never-overlapping labels.
function timeTicks(min: number, max: number, range: Range): number[] {
  if (!isFinite(min) || !isFinite(max) || min >= max) return [];
  const ticks: number[] = [];
  const d = new Date(min);
  if (range === '6h' || range === '24h') {
    const stepH = range === '6h' ? 1 : 3;
    d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil(d.getHours() / stepH) * stepH);   // first aligned hour ≥ min
    while (d.getTime() <= max) {
      if (d.getTime() >= min) ticks.push(d.getTime());
      d.setHours(d.getHours() + stepH);                    // Date math keeps wall-clock alignment across DST
    }
  } else {
    const stepD = range === '7d' ? 1 : 5;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);                            // first midnight after min
    while (d.getTime() <= max) {
      if (d.getTime() >= min) ticks.push(d.getTime());
      d.setDate(d.getDate() + stepD);
    }
  }
  return ticks;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
}

const SOURCE_COLORS: Record<string, string> = {
  auto:      '#69f0ae',
  app:       '#64b5f6',
  button:    '#ffb300',
  failclose: '#ef5350',
};

// Older valve-history records used 'manual' (website) and 'override' (physical
// button); normalise them to the current names so historical bars still render.
function normSource(s: string | null | undefined): string {
  if (s === 'manual') return 'app';
  if (s === 'override') return 'button';
  return s ?? 'auto';
}

const CHART_PROPS = { margin: { top: 8, right: 8, left: 0, bottom: 0 } };
const AXIS_STYLE  = { fill: '#7fa87f', fontSize: 10, fontFamily: 'IBM Plex Mono' };
const TIME_AXIS_STYLE = { fill: '#7fa87f', fontSize: 9, fontFamily: 'IBM Plex Mono' };
const GRID_PROPS  = { stroke: '#2a3f2a', strokeDasharray: '3 3' };
const BRUSH_PROPS = { height: 16, stroke: '#2a3f2a', fill: '#0d1f0e', travellerWidth: 6 };

// Shared props for a clock-aligned numeric time X-axis (used by the line charts).
function timeAxisProps(rows: { ts: number }[], range: Range) {
  const min = rows.length ? rows[0].ts : NaN;
  const max = rows.length ? rows[rows.length - 1].ts : NaN;
  return {
    dataKey: 'ts',
    type: 'number' as const,
    scale: 'time' as const,
    domain: ['dataMin', 'dataMax'] as [string, string],
    ticks: timeTicks(min, max, range),
    tickFormatter: (t: number) => fmtTs(t, range),
    tick: TIME_AXIS_STYLE,
  };
}

function CustomTooltip({ active, payload, label, fmt }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string | number;
  fmt?: (label: string | number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="ct-label">{fmt && label != null ? fmt(label) : label}</div>
      {payload.map(p => (
        <div key={p.name} className="ct-row" style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(1) : p.value}
        </div>
      ))}
    </div>
  );
}

function ClickLegend({
  items, hidden, onToggle,
}: {
  items: { key: string; label: string; color: string }[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="chart-legend-row">
      {items.map(item => (
        <span
          key={item.key}
          className="legend-dot"
          style={{ color: hidden.has(item.key) ? '#444' : item.color, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => onToggle(item.key)}
        >
          ■ {item.label}
        </span>
      ))}
    </div>
  );
}

export default function Charts({ config }: Props) {
  const [tab, setTab]       = useState<Tab>('moisture');
  const [range, setRange]   = useState<Range>('24h');
  const [sensors, setSensors] = useState<SensorRow[]>([]);
  const [valves, setValves]   = useState<ValveEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const now  = Date.now();
    const from = now - RANGE_MS[range];
    try {
      if (tab === 'valves') {
        const { items } = await api.valveHistory(from, now);
        setValves(items);
      } else {
        const { items } = await api.sensors(from, now);
        setSensors(items);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, [tab, range]);

  useEffect(() => { load(); }, [load]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'moisture', label: 'Moisture' },
    { id: 'climate',  label: 'Climate'  },
    { id: 'valves',   label: 'Valves'   },
    { id: 'battery',  label: 'Battery'  },
  ];

  return (
    <div className="charts-view">
      <div className="chart-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`chart-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="range-btns">
        {(['6h', '24h', '7d', '30d'] as Range[]).map(r => (
          <button key={r} className={`range-btn${range === r ? ' active' : ''}`} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
      </div>

      {loading && <div className="chart-loading"><div className="spinner" /></div>}
      {error   && <div className="chart-error">{error}</div>}

      {!loading && !error && (
        <>
          {tab === 'moisture' && <MoistureChart data={sensors} range={range} config={config} />}
          {tab === 'climate'  && <ClimateChart  data={sensors} range={range} />}
          {tab === 'valves'   && <ValvesSection data={valves}  range={range} />}
          {tab === 'battery'  && <BatteryChart  data={sensors} range={range} />}
        </>
      )}
    </div>
  );
}

// ─── Moisture ────────────────────────────────────────────────────────────────

const MOISTURE_SERIES = [
  { key: 'soilA1',   label: 'A1',   color: '#69f0ae' },
  { key: 'soilA2',   label: 'A2',   color: '#a5d6a7' },
  { key: 'soilB1',   label: 'B1',   color: '#64b5f6' },
  { key: 'soilB2',   label: 'B2',   color: '#90caf9' },
  { key: 'soilPoly', label: 'Poly', color: '#ffb300' },
];

function MoistureChart({ data, range, config }: { data: SensorRow[]; range: Range; config: Config | null }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setHidden(prev => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  const rows = data
    .map(r => ({
      ts:       r.ts,
      soilA1:   adcPct(r.soilA1),
      soilA2:   adcPct(r.soilA2),
      soilB1:   adcPct(r.soilB1),
      soilB2:   adcPct(r.soilB2),
      soilPoly: adcPct(r.soilPoly),
    }))
    .sort((a, b) => a.ts - b.ts);

  const threshLines = config
    ? [
        { zone: 'bedsA'      as ZoneName, label: 'A', color: '#69f0ae' },
        { zone: 'bedsB'      as ZoneName, label: 'B', color: '#64b5f6' },
        { zone: 'polytunnel' as ZoneName, label: 'P', color: '#ffb300' },
      ].flatMap(({ zone, label, color }) => {
        const pct = adcPct(config.soilThreshold[zone]);
        return pct != null ? [{ label, color, pct }] : [];
      })
    : [];

  return (
    <div className="chart-wrap">
      <div className="chart-title">Soil moisture %</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(rows, range)} />
          <YAxis tick={AXIS_STYLE} domain={[0, 100]} unit="%" />
          <Tooltip content={<CustomTooltip fmt={t => fmtTs(Number(t), range)} />} />
          <Brush dataKey="ts" {...BRUSH_PROPS} tickFormatter={t => fmtTs(Number(t), range)} />
          {threshLines.map(t => (
            <ReferenceLine key={t.label} y={t.pct}
              stroke={t.color} strokeDasharray="4 4" strokeOpacity={0.6}
              label={{ value: `${t.label}: start watering at ${t.pct}%`, fill: t.color, fontSize: 8, position: 'insideTopRight' }}
            />
          ))}
          {MOISTURE_SERIES.map(s => (
            <Line key={s.key} type="monotone" dataKey={s.key}
              stroke={s.color} dot={false} strokeWidth={1.5}
              name={s.label} connectNulls hide={hidden.has(s.key)}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <ClickLegend items={MOISTURE_SERIES} hidden={hidden} onToggle={toggle} />
    </div>
  );
}

// ─── Climate ─────────────────────────────────────────────────────────────────

const CLIMATE_SERIES = [
  { key: 'tempC', label: 'Temp °C', color: '#ffb300' },
  { key: 'rh',    label: 'RH %',    color: '#64b5f6' },
];

// The DHT11 occasionally emits a garbage sample (e.g. 0 K / -273.15 °C) that skews
// the auto-scaled temp axis. Treat physically-impossible values as missing; an
// out-of-range temp means the whole read failed, so drop its paired RH too.
const TEMP_MIN = -40, TEMP_MAX = 80;   // DHT11 spec is 0–50 °C; padded generously
function sanitiseClimate(r: SensorRow): { tempC: number | null; rh: number | null } {
  const tempBad = r.tempC == null || r.tempC < TEMP_MIN || r.tempC > TEMP_MAX;
  if (tempBad) return { tempC: null, rh: null };
  const rhBad = r.rh == null || r.rh < 0 || r.rh > 100;
  return { tempC: r.tempC, rh: rhBad ? null : r.rh };
}

function ClimateChart({ data, range }: { data: SensorRow[]; range: Range }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setHidden(prev => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  const rows = data
    .map(r => ({ ts: r.ts, ...sanitiseClimate(r) }))
    .sort((a, b) => a.ts - b.ts);

  return (
    <div className="chart-wrap">
      <div className="chart-title">Polytunnel — temp °C (left) · humidity % (right)</div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={rows} margin={{ top: 8, right: 32, left: 4, bottom: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(rows, range)} />
          <YAxis yAxisId="temp" tick={AXIS_STYLE} domain={['auto', 'auto']} />
          <YAxis yAxisId="rh" orientation="right" tick={AXIS_STYLE} domain={[0, 100]} />
          <Tooltip content={<CustomTooltip fmt={t => fmtTs(Number(t), range)} />} />
          <Brush dataKey="ts" {...BRUSH_PROPS} tickFormatter={t => fmtTs(Number(t), range)} />
          <Area yAxisId="rh" type="monotone" dataKey="rh"
            stroke="#64b5f6" fill="#64b5f620" strokeWidth={1}
            name="RH %" connectNulls hide={hidden.has('rh')}
          />
          <Line yAxisId="temp" type="monotone" dataKey="tempC"
            stroke="#ffb300" dot={false} strokeWidth={2}
            name="Temp °C" connectNulls hide={hidden.has('tempC')}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <ClickLegend items={CLIMATE_SERIES} hidden={hidden} onToggle={toggle} />
    </div>
  );
}

// ─── Valves (duration by source) + Usage (total by zone) ─────────────────────

function ValvesSection({ data, range }: { data: ValveEvent[]; range: Range }) {
  return (
    <>
      <ValvesChart data={data} range={range} />
      <UsageChart  data={data} range={range} />
    </>
  );
}

const SOURCE_SERIES = [
  { key: 'auto',      label: 'Auto',       color: '#69f0ae' },
  { key: 'app',       label: 'App',        color: '#64b5f6' },
  { key: 'button',    label: 'Button',     color: '#ffb300' },
  { key: 'failclose', label: 'Fail-close', color: '#ef5350' },
];

function buildValveRows(data: ValveEvent[], range: Range): {
  rows: (Record<string, number> & { day: string })[];
  unit: string;
  tickFmt: (v: number) => string;
} {
  type DayRow = Record<string, number> & { day: string };
  const dayMap  = new Map<string, DayRow>();
  const opens   = new Map<string, { ts: number; source: string }>();
  const rawDurs = new Map<string, number>();

  [...data].sort((a, b) => a.ts - b.ts).forEach(ev => {
    if (!ev.zone) return;
    if (ev.action === 'open') {
      opens.set(ev.zone, { ts: ev.ts, source: normSource(ev.source) });
    } else if (ev.action === 'close') {
      const open = opens.get(ev.zone);
      if (open) {
        const col = `${ev.zone}_${open.source}`;
        rawDurs.set(col, (rawDurs.get(col) ?? 0) + (ev.ts - open.ts) / 60000);
        opens.delete(ev.zone);
      }
    }
  });

  const maxDurMin  = Math.max(0, ...[...rawDurs.values()]);
  const useSeconds = maxDurMin < 2;
  const toDisplay  = (min: number) => useSeconds ? min * 60 : min;
  const unit       = useSeconds ? 'sec' : 'min';
  const tickFmt    = (v: number) => useSeconds ? `${Math.round(v)}s` : `${v.toFixed(1)}m`;

  opens.clear();
  [...data].sort((a, b) => a.ts - b.ts).forEach(ev => {
    if (!ev.zone) return;
    if (ev.action === 'open') {
      opens.set(ev.zone, { ts: ev.ts, source: normSource(ev.source) });
    } else if (ev.action === 'close') {
      const open = opens.get(ev.zone);
      if (open) {
        const day = range === '6h' || range === '24h' ? fmtTs(ev.ts, range) : dayKey(ev.ts);
        if (!dayMap.has(day)) dayMap.set(day, { day } as DayRow);
        const row = dayMap.get(day)!;
        const col = `${ev.zone}_${open.source}`;
        row[col] = ((row[col] as number) ?? 0) + toDisplay((ev.ts - open.ts) / 60000);
        opens.delete(ev.zone);
      }
    }
  });

  return { rows: [...dayMap.values()], unit, tickFmt };
}

function ValvesChart({ data, range }: { data: ValveEvent[]; range: Range }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setHidden(prev => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  const { rows, unit, tickFmt } = buildValveRows(data, range);
  const zones: ZoneName[]       = ['bedsA', 'bedsB', 'polytunnel'];
  const sources                 = ['auto', 'app', 'button', 'failclose'];

  return (
    <div className="chart-wrap">
      <div className="chart-title">Valve open duration ({unit})</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} {...CHART_PROPS}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="day" tick={AXIS_STYLE} interval="preserveStartEnd" />
          <YAxis tick={AXIS_STYLE} tickFormatter={tickFmt} />
          <Tooltip content={<CustomTooltip />} cursor={false} />
          <Brush dataKey="day" {...BRUSH_PROPS} />
          {zones.flatMap(z =>
            sources.map(s => (
              <Bar key={`${z}_${s}`} dataKey={`${z}_${s}`} stackId={z}
                fill={SOURCE_COLORS[s]} name={`${z}/${s}`}
                barSize={6} legendType="none" hide={hidden.has(s)}
              />
            ))
          )}
        </BarChart>
      </ResponsiveContainer>
      <ClickLegend items={SOURCE_SERIES} hidden={hidden} onToggle={toggle} />
    </div>
  );
}

const ZONE_SERIES = [
  { key: 'bedsA',      label: 'Beds A',     color: '#69f0ae' },
  { key: 'bedsB',      label: 'Beds B',     color: '#64b5f6' },
  { key: 'polytunnel', label: 'Polytunnel', color: '#ffb300' },
];

function UsageChart({ data, range }: { data: ValveEvent[]; range: Range }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setHidden(prev => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  type DayRow = Record<string, number> & { day: string };
  const dayMap    = new Map<string, DayRow>();
  const rawOpens  = new Map<string, number>();
  const rawDursU  = new Map<string, number>();

  [...data].sort((a, b) => a.ts - b.ts).forEach(ev => {
    if (!ev.zone) return;
    if (ev.action === 'open') {
      rawOpens.set(ev.zone, ev.ts);
    } else if (ev.action === 'close') {
      const openTs = rawOpens.get(ev.zone);
      if (openTs != null) {
        rawDursU.set(ev.zone, (rawDursU.get(ev.zone) ?? 0) + (ev.ts - openTs) / 60000);
        rawOpens.delete(ev.zone);
      }
    }
  });

  const maxDurMin  = Math.max(0, ...[...rawDursU.values()]);
  const useSeconds = maxDurMin < 2;
  const toDisplay  = (min: number) => useSeconds ? min * 60 : min;
  const unit       = useSeconds ? 'sec' : 'min';
  const tickFmt    = (v: number) => useSeconds ? `${Math.round(v)}s` : `${v.toFixed(1)}m`;

  const opens2 = new Map<string, number>();
  [...data].sort((a, b) => a.ts - b.ts).forEach(ev => {
    if (!ev.zone) return;
    if (ev.action === 'open') {
      opens2.set(ev.zone, ev.ts);
    } else if (ev.action === 'close') {
      const openTs = opens2.get(ev.zone);
      if (openTs != null) {
        const day = range === '6h' || range === '24h' ? fmtTs(ev.ts, range) : dayKey(ev.ts);
        if (!dayMap.has(day)) dayMap.set(day, { day } as DayRow);
        const row = dayMap.get(day)!;
        row[ev.zone] = ((row[ev.zone] as number) ?? 0) + toDisplay((ev.ts - openTs) / 60000);
        opens2.delete(ev.zone);
      }
    }
  });

  const rows = [...dayMap.values()];

  return (
    <div className="chart-wrap">
      <div className="chart-title">Watering time per zone ({unit})</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} {...CHART_PROPS}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="day" tick={AXIS_STYLE} interval="preserveStartEnd" />
          <YAxis tick={AXIS_STYLE} tickFormatter={tickFmt} />
          <Tooltip content={<CustomTooltip />} cursor={false} />
          <Brush dataKey="day" {...BRUSH_PROPS} />
          {ZONE_SERIES.map(z => (
            <Bar key={z.key} dataKey={z.key} fill={z.color} name={z.label}
              barSize={6} legendType="none" hide={hidden.has(z.key)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <ClickLegend items={ZONE_SERIES} hidden={hidden} onToggle={toggle} />
    </div>
  );
}

// ─── Battery ─────────────────────────────────────────────────────────────────

function BatteryChart({ data, range }: { data: SensorRow[]; range: Range }) {
  const rows = data
    .filter(r => r.battV != null)
    .map(r => ({ ts: r.ts, battV: r.battV }))
    .sort((a, b) => a.ts - b.ts);

  return (
    <div className="chart-wrap">
      <div className="chart-title">Battery voltage</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} {...CHART_PROPS}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(rows, range)} />
          <YAxis tick={AXIS_STYLE} domain={[11, 14]} unit="V" />
          <Tooltip content={<CustomTooltip fmt={t => fmtTs(Number(t), range)} />} />
          <Brush dataKey="ts" {...BRUSH_PROPS} tickFormatter={t => fmtTs(Number(t), range)} />
          <ReferenceLine y={13.2} stroke="#69f0ae" strokeDasharray="4 4"
            label={{ value: 'full', fill: '#69f0ae', fontSize: 9 }} />
          <ReferenceLine y={11.5} stroke="#ef5350" strokeDasharray="4 4"
            label={{ value: 'empty', fill: '#ef5350', fontSize: 9 }} />
          <Line type="monotone" dataKey="battV" stroke="#69f0ae" dot={false} strokeWidth={2} name="V" connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
