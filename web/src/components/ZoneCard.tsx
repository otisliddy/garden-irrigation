interface Props {
  label: string;
  isOpen: boolean;
  isPending?: boolean;
  soilKeys: string[];
  soilValues: (number | null)[];
  soilThreshold: number;
  onOpen: () => void;
  onClose: () => void;
  onSkipNext: () => void;
  loading: boolean;
}

const ADC_WET = 1300;  // fully submerged
const ADC_DRY = 3350;  // dry in air

function wetPct(adc: number | null): number {
  if (adc == null) return 50;
  return Math.round(Math.max(0, Math.min(100, (ADC_DRY - adc) / (ADC_DRY - ADC_WET) * 100)));
}

function soilColor(pct: number): string {
  if (pct > 65) return '#64b5f6';
  if (pct > 35) return '#69f0ae';
  if (pct > 15) return '#ffb300';
  return '#ef5350';
}

export default function ZoneCard({
  label, isOpen, isPending, soilKeys, soilValues,
  soilThreshold,
  onOpen, onClose, onSkipNext, loading,
}: Props) {
  const threshPct = wetPct(soilThreshold); // marker: water below this moisture level

  return (
    <div className={`zone-card${isOpen ? ' open' : ''}`}>
      <div className="zone-header">
        <span className="zone-name">{label}</span>
        {isPending && <span className="zone-pending">pending</span>}
        <span className={`zone-dot${isOpen ? ' open' : ''}`} />
      </div>

      <div className="soil-bars">
        {soilKeys.map((key, i) => {
          const pct = wetPct(soilValues[i] ?? null);
          return (
            <div key={key} className="soil-row">
              <span>{key}</span>
              {/* Track with threshold marker */}
              <div className="soil-track" style={{ position: 'relative' }}>
                <div
                  className="soil-fill"
                  style={{ width: `${pct}%`, backgroundColor: soilColor(pct) }}
                />
                {/* Vertical tick at threshold */}
                <div style={{
                  position: 'absolute', top: 0, bottom: 0,
                  left: `${threshPct}%`,
                  width: 1, background: 'rgba(255,179,0,0.5)',
                  pointerEvents: 'none',
                }} />
              </div>
              <span className="soil-num">{soilValues[i] != null ? wetPct(soilValues[i]!) + '%' : '—'}</span>
            </div>
          );
        })}
      </div>

      <div className="zone-actions">
        <button
          className={`btn-toggle ${isOpen ? 'open-state' : 'closed'}`}
          onClick={isOpen ? onClose : onOpen}
        >
          {isOpen ? 'Close valve' : 'Open valve'}
        </button>
        <button className="btn-skip" onClick={onSkipNext}>
          Skip next auto
        </button>
      </div>

      {loading && (
        <div className="zone-loading">
          <div className="spinner" />
        </div>
      )}
    </div>
  );
}
