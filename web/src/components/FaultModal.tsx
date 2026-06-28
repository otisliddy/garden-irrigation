import { useEffect, useState } from 'react';
import type { Config, DeviceStatus, ValveEvent, ZoneName } from '../api';
import { api } from '../api';

interface Props {
  status: DeviceStatus;
  config: Config | null;
  onClose: () => void;
}

const ZONE_LABEL: Record<ZoneName, string> = {
  bedsA: 'Beds A',
  bedsB: 'Beds B',
  polytunnel: 'Polytunnel',
};

interface CapHit {
  zone: ZoneName;
  day: string;        // YYYY-MM-DD (local)
  totalSec: number;   // summed close durations that day
  lastTs: number;     // ms of the last close that day
}

// The firmware only reports `fault: true` (a boolean). It is set in exactly one
// place: a zone whose watering reaches the daily cap (`dailyCapMin`) is force-closed.
// We reconstruct "which zone, when" from valve-history: sum each zone's close
// durations per local day and flag any day that reached the cap.
function findCapHits(events: ValveEvent[], capMin: number): CapHit[] {
  const capSec = capMin * 60;
  const byKey = new Map<string, CapHit>();
  for (const e of events) {
    if (e.action !== 'close' || !e.zone || !e.durationSec) continue;
    const d = new Date(e.ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const key = `${e.zone}|${day}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.totalSec += e.durationSec;
      prev.lastTs = Math.max(prev.lastTs, e.ts);
    } else {
      byKey.set(key, { zone: e.zone, day, totalSec: e.durationSec, lastTs: e.ts });
    }
  }
  // 0.95 tolerance: a session may close a few seconds shy of the exact cap.
  return [...byKey.values()]
    .filter(h => h.totalSec >= capSec * 0.95)
    .sort((a, b) => b.lastTs - a.lastTs);
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export default function FaultModal({ status, config, onClose }: Props) {
  const [hits, setHits] = useState<CapHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capMin = config?.dailyCapMin ?? 90;

  useEffect(() => {
    let alive = true;
    api.valveHistory()
      .then(r => {
        if (!alive) return;
        const cutoff = Date.now() - 4 * 24 * 3600 * 1000;   // last 4 days
        const recent = r.items.filter(e => e.ts >= cutoff);
        setHits(findCapHits(recent, capMin));
      })
      .catch(e => alive && setError(String(e)));
    return () => { alive = false; };
  }, [capMin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <span className="modal-title">⚠ Device fault</span>
          <button className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="modal-lead">
          A zone’s watering ran the full <b>daily cap ({capMin} min)</b> without the soil
          reaching its stop level, so the firmware force-closed the valve and raised a fault.
          It’s a safety stop — nothing is broken or stuck open.
        </p>

        <div className="modal-section">
          <div className="modal-sec-head">What happened</div>
          {error && <div className="modal-dim">Couldn’t load valve history: {error}</div>}
          {!error && hits == null && <div className="modal-dim">Loading valve history…</div>}
          {hits != null && hits.length === 0 && (
            <div className="modal-dim">
              No recent zone reached the daily cap in the last 4 days. The flag may be left
              over from an earlier event — it clears at the next daily counter reset.
            </div>
          )}
          {hits != null && hits.length > 0 && (
            <ul className="modal-list">
              {hits.map(h => (
                <li key={`${h.zone}-${h.day}`}>
                  <b>{ZONE_LABEL[h.zone]}</b> watered{' '}
                  <span className="modal-hl">{Math.round(h.totalSec / 60)} min</span>{' '}
                  (cap {capMin}) — {fmtWhen(h.lastTs)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal-section">
          <div className="modal-sec-head">Likely cause</div>
          <ul className="modal-list">
            <li>Soil never got wet enough to hit the <b>stop</b> threshold — the target may be
              set wetter than the bed physically reaches, so it waters until the cap.</li>
            <li>Or water isn’t reaching that bed (closed/blocked drip line, or a valve that
              didn’t physically open) — moisture stays flat while the valve is “open”.</li>
          </ul>
        </div>

        <div className="modal-section">
          <div className="modal-sec-head">How to clear it</div>
          <ul className="modal-list">
            <li>It clears itself at the next <b>daily counter reset</b> (~24 h after it tripped),
              or immediately on a <b>power-cycle</b>. It re-trips next day if the cause persists.</li>
            <li>To stop it recurring: raise <b>Daily cap</b>, or lower the <b>stop</b> moisture
              target in Settings so it’s actually reachable.</li>
          </ul>
        </div>

        <div className="modal-foot">
          <span>FW {status.fw ?? '?'}</span>
          <span>last seen {status.lastSeenEpoch ? fmtWhen(status.lastSeenEpoch * 1000) : '—'}</span>
        </div>
      </div>
    </div>
  );
}
