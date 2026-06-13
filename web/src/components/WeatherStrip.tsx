import type { Weather } from '../api';

interface Props {
  weather: Weather;
  rainSkipThreshMm?: number;
}

function wmoIcon(code: number | null): string {
  if (code == null) return '🌡️';
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 55) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  if (code <= 86) return '🌨️';
  return '⛈️';
}

function fmtHour(ts: number): string {
  return new Date(ts).getHours().toString().padStart(2, '0') + 'h';
}

export default function WeatherStrip({ weather, rainSkipThreshMm = 3 }: Props) {
  const { current, forecast, rainSum12h } = weather;
  const willSkip = rainSum12h >= rainSkipThreshMm;

  return (
    <div className="weather-card">
      {current && (
        <div className="weather-current">
          <span className="w-icon">{wmoIcon(current.weatherCode)}</span>
          <div>
            <div className="w-temp">{current.tempC.toFixed(1)}°C</div>
            <div className="w-rh">{current.rh}% RH</div>
          </div>
          <div className="w-rain">
            <div className="w-rain-mm">🌧 {rainSum12h.toFixed(1)} mm / 12 h</div>
            {willSkip && <div className="rain-skip-badge">rain skip active</div>}
          </div>
        </div>
      )}

      {forecast.length > 0 && (
        <div className="forecast-scroll">
          {forecast.slice(0, 24).map(pt => (
            <div key={pt.ts} className="fc-point">
              <span className="fc-hr">{fmtHour(pt.ts)}</span>
              <span className="fc-wi">{wmoIcon(pt.weatherCode)}</span>
              <span className="fc-t">{pt.tempC != null ? `${Math.round(pt.tempC)}°` : '—'}</span>
              {(pt.precipMm ?? 0) > 0.1 && (
                <span className="fc-r">{pt.precipMm!.toFixed(1)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
