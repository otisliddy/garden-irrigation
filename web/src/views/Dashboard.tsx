import { useState, useEffect } from 'react';
import type { DeviceStatus, Weather, SensorRow, Config, ZoneName } from '../api';
import { api } from '../api';
import ZoneCard from '../components/ZoneCard';
import WeatherStrip from '../components/WeatherStrip';
import FaultModal from '../components/FaultModal';

interface Props {
  status: DeviceStatus | null;
  weather: Weather | null;
  latestSensor: SensorRow | null;
  config: Config | null;
}

const BATT_FULL  = 13.2;
const BATT_EMPTY = 11.5;

function battPct(v: number | null): number {
  if (v == null) return 0;
  return Math.round(Math.max(0, Math.min(100, (v - BATT_EMPTY) / (BATT_FULL - BATT_EMPTY) * 100)));
}

function battColor(pct: number): string {
  if (pct > 50) return 'var(--accent)';
  if (pct > 20) return 'var(--warning)';
  return 'var(--danger)';
}

const ZONES: { zone: ZoneName; label: string; keys: string[]; sensorFields: (keyof SensorRow)[] }[] = [
  { zone: 'bedsA',      label: 'Beds A',    keys: ['A1','A2'],   sensorFields: ['soilA1','soilA2'] },
  { zone: 'bedsB',      label: 'Beds B',    keys: ['B1','B2'],   sensorFields: ['soilB1','soilB2'] },
  { zone: 'polytunnel', label: 'Polytunnel',keys: ['P'],         sensorFields: ['soilPoly'] },
];

export default function Dashboard({ status, weather, latestSensor, config }: Props) {
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [pendingOpen, setPendingOpen] = useState<Partial<Record<ZoneName, boolean>>>({});
  const [showFault, setShowFault] = useState(false);

  // Clear pending state once the device shadow confirms the expected valve state
  useEffect(() => {
    if (!status?.valve) return;
    setPendingOpen(prev => {
      const next = { ...prev };
      let changed = false;
      for (const z of Object.keys(next) as ZoneName[]) {
        if (status.valve![z]?.open === next[z]) {
          delete next[z];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [status]);

  const pct = battPct(status?.battV ?? null);
  const col = battColor(pct);

  async function toggle(zone: ZoneName, open: boolean) {
    setLoading(l => ({ ...l, [zone]: true }));
    try {
      await api.zoneSet(zone, open);
      setPendingOpen(p => ({ ...p, [zone]: open }));
    } finally {
      setLoading(l => ({ ...l, [zone]: false }));
    }
  }

  return (
    <div>
      {/* Status banner */}
      <div className="status-banner">
        {status ? (
          <>
            <span className={`chip ${status.online ? 'chip-online' : 'chip-offline'}`}>
              ● {status.online ? 'online' : 'offline'}
            </span>
            {status.mode === 'power-save' && (
              <span className="chip chip-powersave">⚡ pwr save</span>
            )}
            {status.fault && (
              <button className="chip chip-fault" onClick={() => setShowFault(true)}>
                ⚠ fault ⓘ
              </button>
            )}
            <div className="batt-wrap" style={{ color: col }}>
              <div className="batt-icon">
                <div className="batt-fill" style={{ width: `${pct}%`, background: col }} />
              </div>
              {status.battV != null && (
                <span className="batt-v">{status.battV.toFixed(1)}V</span>
              )}
            </div>
            {status.fw && <span className="fw-badge">FW {status.fw}</span>}
          </>
        ) : (
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>connecting…</span>
        )}
      </div>

      {/* Zone cards */}
      <div className="zone-grid">
        {ZONES.map(({ zone, label, keys, sensorFields }) => {
          const confirmedOpen = status?.valve?.[zone]?.open ?? false;
          const isPending = zone in pendingOpen;
          const isOpen = isPending ? pendingOpen[zone]! : confirmedOpen;
          return (
            <ZoneCard
              key={zone}
              label={label}
              isOpen={isOpen}
              isPending={isPending}
              soilKeys={keys}
              soilValues={sensorFields.map(f => latestSensor?.[f] as number | null ?? null)}
              soilThreshold={config?.soilThreshold?.[zone] ?? 2800}
              tempC={zone === 'polytunnel' ? (latestSensor?.tempC ?? null) : undefined}
              onOpen={() => toggle(zone, true)}
              onClose={() => toggle(zone, false)}
              loading={loading[zone] ?? false}
            />
          );
        })}
      </div>

      {/* Weather */}
      {weather && (
        <div className="weather-section">
          <WeatherStrip weather={weather} rainSkipThreshMm={config?.rainSkipMm} />
        </div>
      )}

      {showFault && status && (
        <FaultModal status={status} config={config} onClose={() => setShowFault(false)} />
      )}
    </div>
  );
}
