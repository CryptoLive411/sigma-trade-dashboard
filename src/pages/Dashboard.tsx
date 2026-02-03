import useSWR from 'swr';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Layout } from '@/components/Layout';
import { getSocket } from '@/lib/socket';
import { Sparkline } from '@/components/Sparkline';
import { PnLMap } from '@/components/PnLMap';

const fetcher = (url: string) => api.get(url).then(r => r.data).catch(() => null);

interface TrackerMetric {
  id: string;
  name: string;
  metrics?: {
    activeEthWei?: string;
    realizedPnLEthWei?: string;
  };
}

interface Metrics {
  activeEthWei?: string;
  realizedPnLEthWei?: string;
  perTracker?: TrackerMetric[];
}

interface Stats {
  uptime?: number;
  load?: number[];
}

const MOCK_STATS: Stats = { uptime: 3600, load: [0.5, 0.3, 0.2] };
const MOCK_METRICS: Metrics = {
  activeEthWei: '50000000000000000',
  realizedPnLEthWei: '120000000000000000',
  perTracker: [
    { id: 'uniswapv3', name: 'UniswapV3', metrics: { activeEthWei: '20000000000000000', realizedPnLEthWei: '50000000000000000' } },
    { id: 'baseswapv3', name: 'BaseSwapV3', metrics: { activeEthWei: '15000000000000000', realizedPnLEthWei: '40000000000000000' } },
    { id: 'aerodrome', name: 'Aerodrome', metrics: { activeEthWei: '10000000000000000', realizedPnLEthWei: '20000000000000000' } },
    { id: 'clankerv4', name: 'ClankerV4', metrics: { activeEthWei: '5000000000000000', realizedPnLEthWei: '10000000000000000' } },
  ]
};

export default function Dashboard() {
  const { data: statsRaw } = useSWR<Stats | null>('/api/stats', fetcher, { refreshInterval: 5000 });
  const { data: metricsRaw } = useSWR<Metrics | null>('/api/trackers/metrics', fetcher, { refreshInterval: 3000 });
  const stats = statsRaw || MOCK_STATS;
  const metrics = metricsRaw || MOCK_METRICS;
  const [pnlSeries, setPnlSeries] = useState<number[]>([]);
  const [realizedHistory, setRealizedHistory] = useState<number[]>([]);
  const [activeHistory, setActiveHistory] = useState<number[]>([]);

  useEffect(() => {
    if (!metrics) return;
    const toEth = (w: string | undefined) => {
      const n = Number(w || 0);
      return isFinite(n) ? n / 1e18 : 0;
    };
    setRealizedHistory(h => [...h.slice(-300), toEth(metrics.realizedPnLEthWei)]);
    setActiveHistory(h => [...h.slice(-300), toEth(metrics.activeEthWei)]);
  }, [metrics]);

  useEffect(() => {
    const s = getSocket();
    const onMon = (m: { pnlPct?: number; pnl?: number }) => {
      const val = (typeof m?.pnlPct === 'number') ? m.pnlPct : (typeof m?.pnl === 'number' ? m.pnl : null);
      if (val != null) setPnlSeries((arr) => [...arr.slice(-300), val]);
    };
    s.on('trade:monitor', onMon);
    return () => { s.off('trade:monitor', onMon); };
  }, []);

  const toEth = (wei: string | undefined) => {
    if (!wei) return 0;
    const n = Number(wei);
    if (!isFinite(n)) return 0;
    return n / 1e18;
  };

  const perTrackerPnl = useMemo(() => {
    if (!metrics) return [];
    return (metrics.perTracker || []).map(t => ({
      id: t.id,
      name: t.name,
      value: toEth(t.metrics?.realizedPnLEthWei)
    }));
  }, [metrics]);

  return (
    <Layout title="Dashboard">
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-background border border-border rounded-lg p-3">
            <div className="text-muted-foreground text-sm">Active Exposure</div>
            <div className="text-2xl font-bold">{metrics ? toEth(metrics.activeEthWei).toFixed(6) : '—'} ETH</div>
          </div>
          <div className="bg-background border border-border rounded-lg p-3">
            <div className="text-muted-foreground text-sm">Realized PnL</div>
            <div className="text-2xl font-bold">{metrics ? toEth(metrics.realizedPnLEthWei).toFixed(6) : '—'} ETH</div>
          </div>
          <div className="bg-background border border-border rounded-lg p-3">
            <div className="text-muted-foreground text-sm">Uptime</div>
            <div className="text-2xl font-bold">{stats ? (stats.uptime! / 3600).toFixed(2) : '—'} h</div>
          </div>
          <div className="bg-background border border-border rounded-lg p-3">
            <div className="text-muted-foreground text-sm">Load Avg</div>
            <div className="text-2xl font-bold">{stats?.load ? stats.load.map(n => n.toFixed(2)).join(' / ') : '—'}</div>
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="m-0 text-lg font-semibold">Per-Tracker Metrics</h3>
          <a className="px-3 py-1 bg-primary text-primary-foreground rounded-lg text-sm" href="/trackers">Manage Trackers</a>
        </div>
        {!metrics ? <div>Loading...</div> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left p-2">Tracker</th>
                  <th className="text-left p-2">Active (ETH)</th>
                  <th className="text-left p-2">Realized PnL (ETH)</th>
                </tr>
              </thead>
              <tbody>
                {(metrics.perTracker || []).map(t => (
                  <tr key={t.id} className="border-b border-border">
                    <td className="p-2">{t.name}</td>
                    <td className="p-2">{toEth(t.metrics?.activeEthWei).toFixed(6)}</td>
                    <td className="p-2">{toEth(t.metrics?.realizedPnLEthWei).toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="m-0 text-lg font-semibold">Live PnL % Sparkline</h3>
          <span className="text-xs text-muted-foreground">Samples: {pnlSeries.length}</span>
        </div>
        <div className="mt-2">
          <Sparkline data={pnlSeries} width={500} height={60} color="#38bdf8" fill="rgba(56,189,248,0.12)" />
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-4 grid md:grid-cols-2 gap-6">
        <div>
          <h3 className="m-0 text-lg font-semibold">Realized PnL (ETH)</h3>
          <div className="mt-2">
            <Sparkline data={realizedHistory} width={500} height={60} color="#10b981" fill="rgba(16,185,129,0.12)" />
          </div>
        </div>
        <div>
          <h3 className="m-0 text-lg font-semibold">Active Exposure (ETH)</h3>
          <div className="mt-2">
            <Sparkline data={activeHistory} width={500} height={60} color="#f59e0b" fill="rgba(245,158,11,0.12)" />
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="m-0 text-lg font-semibold mb-3">Per-Tracker Realized PnL Map</h3>
        <PnLMap items={perTrackerPnl} />
      </div>
    </Layout>
  );
}
