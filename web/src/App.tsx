import { useState } from 'react';
import { api } from './api';
import { usePoller } from './hooks/usePoller';
import Dashboard from './views/Dashboard';
import Charts from './views/Charts';
import Settings from './views/Settings';

type Tab = 'dashboard' | 'charts' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');

  const { data: status } = usePoller(api.status, 5_000);
  const { data: weather } = usePoller(api.weather, 60_000);
  const { data: sensorsData } = usePoller(
    () => api.sensors(Date.now() - 60 * 60 * 1000),
    30_000,
  );
  const { data: config, refresh: refreshConfig } = usePoller(api.config, 300_000);

  const latestSensor = sensorsData?.items?.at(-1) ?? null;

  return (
    <div className="app">
      <main className="app-main">
        {tab === 'dashboard' && (
          <Dashboard status={status} weather={weather} latestSensor={latestSensor} config={config} />
        )}
        {tab === 'charts' && <Charts config={config} />}
        {tab === 'settings' && (
          <Settings
            config={config}
            onSave={async cfg => { await api.putConfig(cfg); refreshConfig(); }}
          />
        )}
      </main>

      <nav className="tab-bar">
        {(['dashboard', 'charts', 'settings'] as Tab[]).map(t => (
          <button
            key={t}
            className={`tab-btn${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            <span className="tab-icon">
              {t === 'dashboard' ? '🌿' : t === 'charts' ? '📊' : '⚙️'}
            </span>
            <span className="tab-label">
              {t === 'dashboard' ? 'Garden' : t === 'charts' ? 'Charts' : 'Settings'}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}
