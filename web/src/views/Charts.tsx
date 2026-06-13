import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, ComposedChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, Brush,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../api';
import type { SensorRow, ValveEvent, Config, ZoneName } from '../api';

type Tab = 'moisture' | 'climate' | 'valves' | 'battery' | 'usage';
type Range = '6h' | '24h' | '7d' | '30d';

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
  if (range === '6h' || range === '24h') {
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }
  return `${d.getDate()}/${d.getMonth()+1}`;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}`;
}

const ZONE_COLORS: Record<ZoneName, string> = {
  bedsA: '#69f0ae',
  bedsB: '#64b5f6',
  polytunnel: '#ffb300',
};

const SOURCE_COLORS: Record<string, string> = {
  auto: '#69f0ae',
  manual: '#64b5f6',
  override: '#ffb300',
  failclose: '#ef5350',
};

const CHART_PROPS = {
  margin: { top: 8, right: 8, left: 0, bottom: 0 },
};

const AXIS_STYLE = { fill: '#7fa87f', fontSize: 10, fontFamily: 'IBM Plex Mono' };
const GRID_PROPS = { stroke: '#2a3f2a', strokeDasharray: '3 3' };

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="ct-label">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="ct-row" style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(1) : p.value}
        </div>
      ))}
    </div>
  );
}

export default function Charts({ config }: Props) {
  const [tab, setTab] = useState<Tab>('moisture');
  const [range, setRange] = useState<Range>('24h');
  const [sensors, setSensors] = useState<SensorRow[]>([]);
  const [valves, setValves] = useState<ValveEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const now = Date.now();
    const from = now - RANGE_MS[range];
    try {
      if (tab === 'valves' || tab === 'usage') {
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
    { id: 'climate',  label: 'Climate' },
    { id: 'valves',   label: 'Valves' },
    { id: 'battery',  label: 'Battery' },
    { id: 'usage',    label: 'Usage' },
  ];

  const ranges: Range[] = ['6h', '24h', '7d', '30d'];

  return (
    <div className="charts-view">
      <div className="chart-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`chart-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="range-btns">
        {ranges.map(r => (
          <button
            key={r}
            className={`range-btn${range === r ? ' active' : ''}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>

      {loading && <div className="chart-loading"><div className="spinner" /></div>}
      {error && <div className="chart-error">{error}</div>}

      {!loading && !error && (
        <>
          {tab === 'moisture' && <MoistureChart data={sensors} range={range} config={config} />}
          {tab === 'climate'  && <ClimateChart  data={sensors} range={range} />}
          {tab === 'valves'   && <ValvesChart   data={valves}  range={range} />}
          {tab === 'battery'  && <BatteryChart  data={sensors} range={range} />}
          {tab === 'usage'    && <UsageChart    data={valves}  range={range} />}
        </>
      )}
    </div>
  );
}

function MoistureChart({ data, range, config }: {
  data: SensorRow[]; range: Range; config: Config | null;
}) {
  const rows = data.map(r => ({
    ts: fmtTs(r.ts, range),
    soilA1: r.soilA1, soilA2: r.soilA2,
    soilB1: r.soilB1, soilB2: r.soilB2,
    soilPoly: r.soilPoly,
  }));

  return (
    <div className="chart-wrap">
      <div className="chart-title">Soil ADC (higher = drier)</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="ts" tick={AXIS_STYLE} interval="preserveStartEnd" />
          <YAxis tick={AXIS_STYLE} reversed domain={[800, 3200]} />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'IBM Plex Mono' }} />
          <Brush dataKey="ts" height={16} stroke="#2a3f2a" fill="#0d1f0e" travellerWidth={6} />
          {config && <ReferenceLine y={config.soilThreshold.bedsA}    stroke="#69f0ae" strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: 'A thresh', fill: '#69f0ae', fontSize: 8 }} />}
          {config && <ReferenceLine y={config.soilThreshold.bedsB}    stroke="#64b5f6" strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: 'B thresh', fill: '#64b5f6', fontSize: 8 }} />}
          {config && <ReferenceLine y={config.soilThreshold.polytunnel} stroke="#ffb300" strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: 'P thresh', fill: '#ffb300', fontSize: 8 }} />}
          <Line type="monotone" dataKey="soilA1" stroke="#69f0ae" dot={false} strokeWidth={1.5} name="A1" connectNulls />
          <Line type="monotone" dataKey="soilA2" stroke="#a5d6a7" dot={false} strokeWidth={1.5} name="A2" connectNulls />
          <Line type="monotone" dataKey="soilB1" stroke="#64b5f6" dot={false} strokeWidth={1.5} name="B1" connectNulls />
          <Line type="monotone" dataKey="soilB2" stroke="#90caf9" dot={false} strokeWidth={1.5} name="B2" connectNulls />
          <Line type="monotone" dataKey="soilPoly" stroke="#ffb300" dot={false} strokeWidth={1.5} name="Poly" connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ClimateChart({ data, range }: { data: SensorRow[]; range: Range }) {
  const rows = data.map(r => ({
    ts: fmtTs(r.ts, range),
    tempC: r.tempC,
    rh: r.rh,
  }));

  return (
    <div className="chart-wrap">
      <div className="chart-title">Polytunnel — temp °C (left) · humidity % (right)</div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={rows} margin={{ top: 8, right: 32, left: 4, bottom: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="ts" tick={AXIS_STYLE} interval="preserveStartEnd" />
          <YAxis yAxisId="temp" tick={AXIS_STYLE} domain={['auto','auto']} />
          <YAxis yAxisId="rh" orientation="right" tick={AXIS_STYLE} domain={[0,100]} />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'IBM Plex Mono' }} />
          <Brush dataKey="ts" height={16} stroke="#2a3f2a" fill="#0d1f0e" travellerWidth={6} />
          <Area yAxisId="rh" type="monotone" dataKey="rh" stroke="#64b5f6" fill="#64b5f620" strokeWidth={1} name="RH %" connectNulls />
          <Line yAxisId="temp" type="monotone" dataKey="tempC" stroke="#ffb300" dot={false} strokeWidth={2} name="Temp °C" connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function ValvesChart({ data, range }: { data: ValveEvent[]; range: Range }) {
  // Build per-day per-zone-source open/close event pairs
  type DayRow = Record<string, number> & { day: string };
  const dayMap = new Map<string, DayRow>();

  const opens = new Map<string, { ts: number; source: string }>();

  // First pass: collect durations in minutes to decide unit
  const rawDurs = new Map<string, number>(); // key -> minutes
  opens.clear();
  [...data].sort((a,b) => a.ts - b.ts).forEach(ev => {
    if (!ev.zone) return;
    if (ev.action === 'open') {
      opens.set(ev.zone, { ts: ev.ts, source: ev.source ?? 'auto' });
    } else if (ev.action === 'close') {
      const open = opens.get(ev.zone);
      if (open) {
        const durMin = (ev.ts - open.ts) / 60000;
        const col = `${ev.zone}_${open.source}`;
        rawDurs.set(col, (rawDurs.get(col) ?? 0) + durMin);
        opens.delete(ev.zone);
      }
    }
  });
  const maxDurMin = Math.max(0, ...[...rawDurs.values()]);
  const useSeconds = maxDurMin < 2;
  const toDisplay = (min: number) => useSeconds ? min * 60 : min;
  const unit = useSeconds ? 'sec' : 'min';
  const tickFmt = (v: number) => useSeconds ? `${Math.round(v)}s` : `${v.toFixed(1)}m`;

  // Second pass: build rows with display-unit values
  opens.clear();
  [...data].sort((a,b) => a.ts - b.ts).forEach(ev => {
    if (!ev.zone) return;
    if (ev.action === 'open') {
      opens.set(ev.zone, { ts: ev.ts, source: ev.source ?? 'auto' });
    } else if (ev.action === 'close') {
      const open = opens.get(ev.zone);
      if (open) {
        const durMin = (ev.ts - open.ts) / 60000;
        const day = range === '6h' || range === '24h'
          ? fmtTs(ev.ts, range)
          : dayKey(ev.ts);
        if (!dayMap.has(day)) dayMap.set(day, { day } as DayRow);
        const row = dayMap.get(day)!;
        const col = `${ev.zone}_${open.source}`;
        row[col] = ((row[col] as number) ?? 0) + toDisplay(durMin);
        opens.delete(ev.zone);
      }
    }
  });

  const rows = [...dayMap.values()];
  const zones: ZoneName[] = ['bedsA', 'bedsB', 'polytunnel'];
  const sources = ['auto','manual','override','failclose'];

  return (
    <div className="chart-wrap">
      <div className="chart-title">Valve open duration ({unit})</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} {...CHART_PROPS}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="day" tick={AXIS_STYLE} interval="preserveStartEnd" />
          <YAxis tick={AXIS_STYLE} tickFormatter={tickFmt} />
          <Tooltip content={<CustomTooltip />} />
          <Brush dataKey="day" height={16} stroke="#2a3f2a" fill="#0d1f0e" travellerWidth={6} />
          {zones.flatMap(z =>
            sources.map(s => (
              <Bar key={`${z}_${s}`} dataKey={`${z}_${s}`} stackId={z}
                fill={SOURCE_COLORS[s]} name={`${z}/${s}`} legendType="none" />
            ))
          )}
        </BarChart>
      </ResponsiveContainer>
      <div className="chart-legend-row">
        {sources.map(s => (
          <span key={s} className="legend-dot" style={{ color: SOURCE_COLORS[s] }}>
            ■ {s}
          </span>
        ))}
      </div>
    </div>
  );
}

function BatteryChart({ data, range }: { data: SensorRow[]; range: Range }) {
  const rows = data
    .filter(r => r.battV != null)
    .map(r => ({ ts: fmtTs(r.ts, range), battV: r.battV }));

  return (
    <div className="chart-wrap">
      <div className="chart-title">Battery voltage</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} {...CHART_PROPS}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="ts" tick={AXIS_STYLE} interval="preserveStartEnd" />
          <YAxis tick={AXIS_STYLE} domain={[11, 14]} unit="V" />
          <Tooltip content={<CustomTooltip />} />
          <Brush dataKey="ts" height={16} stroke="#2a3f2a" fill="#0d1f0e" travellerWidth={6} />
          <ReferenceLine y={13.2} stroke="#69f0ae" strokeDasharray="4 4" label={{ value: 'full', fill: '#69f0ae', fontSize: 9 }} />
          <ReferenceLine y={11.5} stroke="#ef5350" strokeDasharray="4 4" label={{ value: 'empty', fill: '#ef5350', fontSize: 9 }} />
          <Line type="monotone" dataKey="battV" stroke="#69f0ae" dot={false} strokeWidth={2} name="V" connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function UsageChart({ data, range }: { data: ValveEvent[]; range: Range }) {
  type DayRow = Record<string, number> & { day: string };
  const dayMap = new Map<string, DayRow>();

  const rawOpens = new Map<string, number>();
  const rawDursU = new Map<ZoneName, number>();

  [...data].sort((a,b) => a.ts - b.ts).forEach(ev => {
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

  const maxDurMin = Math.max(0, ...[...rawDursU.values()]);
  const useSeconds = maxDurMin < 2;
  const toDisplay = (min: number) => useSeconds ? min * 60 : min;
  const unit = useSeconds ? 'sec' : 'min';
  const tickFmt = (v: number) => useSeconds ? `${Math.round(v)}s` : `${v.toFixed(1)}m`;

  const opens2 = new Map<string, number>();
  [...data].sort((a,b) => a.ts - b.ts).forEach(ev => {
    if (!ev.zone) return;
    if (ev.action === 'open') {
      opens2.set(ev.zone, ev.ts);
    } else if (ev.action === 'close') {
      const openTs = opens2.get(ev.zone);
      if (openTs != null) {
        const dur = toDisplay((ev.ts - openTs) / 60000);
        const day = range === '6h' || range === '24h'
          ? fmtTs(ev.ts, range)
          : dayKey(ev.ts);
        if (!dayMap.has(day)) dayMap.set(day, { day } as DayRow);
        const row = dayMap.get(day)!;
        row[ev.zone] = ((row[ev.zone] as number) ?? 0) + dur;
        opens2.delete(ev.zone);
      }
    }
  });

  const rows = [...dayMap.values()];
  const zones: ZoneName[] = ['bedsA', 'bedsB', 'polytunnel'];
  const zoneLabels: Record<ZoneName, string> = { bedsA: 'Beds A', bedsB: 'Beds B', polytunnel: 'Polytunnel' };

  return (
    <div className="chart-wrap">
      <div className="chart-title">Watering time per zone ({unit} / period)</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows} {...CHART_PROPS}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="day" tick={AXIS_STYLE} interval="preserveStartEnd" />
          <YAxis tick={AXIS_STYLE} tickFormatter={tickFmt} />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'IBM Plex Mono' }} />
          <Brush dataKey="day" height={16} stroke="#2a3f2a" fill="#0d1f0e" travellerWidth={6} />
          {zones.map(z => (
            <Bar key={z} dataKey={z} fill={ZONE_COLORS[z]} name={zoneLabels[z]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
