import { useState, useEffect } from 'react';
import type { Config } from '../api';

const ADC_WET = 1300;
const ADC_DRY = 3350;
function adcToPct(adc: number): number {
  return Math.round(Math.max(0, Math.min(100, (ADC_DRY - adc) / (ADC_DRY - ADC_WET) * 100)));
}
function pctToAdc(pct: number): number {
  return Math.round(ADC_DRY - Math.max(0, Math.min(100, pct)) / 100 * (ADC_DRY - ADC_WET));
}

interface Props {
  config: Config | null;
  onSave: (cfg: Partial<Config>) => Promise<void>;
}

export default function Settings({ config, onSave }: Props) {
  const [form, setForm] = useState<Partial<Config>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  function setNum(path: string[], val: string) {
    const n = parseFloat(val);
    if (isNaN(n)) return;
    setForm(prev => {
      const next = { ...prev };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = next;
      for (let i = 0; i < path.length - 1; i++) {
        obj[path[i]] = { ...(obj[path[i]] ?? {}) };
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = n;
      return next;
    });
  }

  function val(path: string[]): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let obj: any = form;
    for (const k of path) {
      if (obj == null) return '';
      obj = obj[k];
    }
    return obj?.toString() ?? '';
  }

  function valAsPct(path: string[]): string {
    const raw = parseFloat(val(path));
    return isNaN(raw) ? '' : adcToPct(raw).toString();
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(form);
      showToast('Saved', true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Error', false);
    } finally {
      setSaving(false);
    }
  }

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 2500);
  }

  const zones = ['bedsA', 'bedsB', 'polytunnel'] as const;
  const zoneLabels = { bedsA: 'Beds A', bedsB: 'Beds B', polytunnel: 'Polytunnel' };

  return (
    <div className="settings-view">
      {/* Per-zone thresholds */}
      <div className="settings-section">
        <div className="settings-heading">Soil thresholds (0 = dry, 100 = wet)</div>
        {zones.map(z => (
          <div key={z}>
            <div className="settings-row">
              <div>
                <div className="s-label">{zoneLabels[z]} — start</div>
                <div className="s-sub">start watering below this %</div>
              </div>
              <input
                className="s-input"
                type="number" min="0" max="100"
                value={valAsPct(['soilThreshold', z])}
                onChange={e => {
                  const pct = parseFloat(e.target.value);
                  if (!isNaN(pct)) setNum(['soilThreshold', z], pctToAdc(pct).toString());
                }}
              />
            </div>
            <div className="settings-row">
              <div>
                <div className="s-label">{zoneLabels[z]} — stop</div>
                <div className="s-sub">stop watering above this %</div>
              </div>
              <input
                className="s-input"
                type="number" min="0" max="100"
                value={valAsPct(['soilStop', z])}
                onChange={e => {
                  const pct = parseFloat(e.target.value);
                  if (!isNaN(pct)) setNum(['soilStop', z], pctToAdc(pct).toString());
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Timing */}
      <div className="settings-section">
        <div className="settings-heading">Watering window</div>
        <div className="settings-row">
          <div>
            <div className="s-label">Start hour</div>
            <div className="s-sub">local time (0–23)</div>
          </div>
          <input
            className="s-input"
            type="number" min="0" max="23"
            value={val(['wateringWindow', 'startHour'])}
            onChange={e => setNum(['wateringWindow', 'startHour'], e.target.value)}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="s-label">End hour</div>
            <div className="s-sub">local time (0–23)</div>
          </div>
          <input
            className="s-input"
            type="number" min="0" max="23"
            value={val(['wateringWindow', 'endHour'])}
            onChange={e => setNum(['wateringWindow', 'endHour'], e.target.value)}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="s-label">Daily cap</div>
            <div className="s-sub">minutes / day / zone</div>
          </div>
          <input
            className="s-input"
            type="number"
            value={val(['dailyCapMin'])}
            onChange={e => setNum(['dailyCapMin'], e.target.value)}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="s-label">Override duration</div>
            <div className="s-sub">minutes for manual open</div>
          </div>
          <input
            className="s-input"
            type="number"
            value={val(['overrideMinutes'])}
            onChange={e => setNum(['overrideMinutes'], e.target.value)}
          />
        </div>
      </div>

      {/* Weather */}
      <div className="settings-section">
        <div className="settings-heading">Weather / safety</div>
        <div className="settings-row">
          <div>
            <div className="s-label">Rain skip</div>
            <div className="s-sub">skip if forecast ≥ X mm / 12 h</div>
          </div>
          <input
            className="s-input"
            type="number" step="0.5"
            value={val(['rainSkipMm'])}
            onChange={e => setNum(['rainSkipMm'], e.target.value)}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="s-label">Freeze guard</div>
            <div className="s-sub">skip watering if temp ≤ X °C</div>
          </div>
          <input
            className="s-input"
            type="number" step="0.5"
            value={val(['freezeGuardC'])}
            onChange={e => setNum(['freezeGuardC'], e.target.value)}
          />
        </div>
      </div>

      <button className="btn-save" onClick={handleSave} disabled={saving || !config}>
        {saving ? 'Saving…' : 'Save settings'}
      </button>

      <div className={`toast ${toast ? 'show' : ''} ${toast?.ok ? 'ok' : 'err'}`}>
        {toast?.msg}
      </div>
    </div>
  );
}
