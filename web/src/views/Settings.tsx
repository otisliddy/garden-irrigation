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
  // In-progress edit text, keyed by field. Lets an input hold a transient
  // empty/partial value (e.g. while deleting digits) without snapping back to
  // the committed number. Cleared on blur so the field reformats from `form`.
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (config) { setForm(config); setRaw({}); }
  }, [config]);

  function commitNum(path: string[], n: number) {
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
    const adc = parseFloat(val(path));
    return isNaN(adc) ? '' : adcToPct(adc).toString();
  }

  function clearRaw(key: string) {
    setRaw(r => { const next = { ...r }; delete next[key]; return next; });
  }

  // Props for a plain numeric field: text edits are held in `raw`, and the
  // parsed number is committed to `form` only when the text is a valid number.
  function numField(path: string[]) {
    const key = path.join('.');
    return {
      value: key in raw ? raw[key] : val(path),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        setRaw(r => ({ ...r, [key]: text }));
        const n = parseFloat(text);
        if (!isNaN(n)) commitNum(path, n);
      },
      onBlur: () => clearRaw(key),
    };
  }

  // Props for a % field whose committed value is stored as ADC in `form`.
  function pctField(path: string[]) {
    const key = `pct:${path.join('.')}`;
    return {
      value: key in raw ? raw[key] : valAsPct(path),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        setRaw(r => ({ ...r, [key]: text }));
        const pct = parseFloat(text);
        if (!isNaN(pct)) commitNum(path, pctToAdc(pct));
      },
      onBlur: () => clearRaw(key),
    };
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
                {...pctField(['soilThreshold', z])}
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
                {...pctField(['soilStop', z])}
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
            {...numField(['wateringWindow', 'startHour'])}
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
            {...numField(['wateringWindow', 'endHour'])}
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
            {...numField(['dailyCapMin'])}
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
            {...numField(['overrideMinutes'])}
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
            {...numField(['rainSkipMm'])}
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
            {...numField(['freezeGuardC'])}
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
