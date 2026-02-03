import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Layout } from '@/components/Layout';
import { useToast } from '@/hooks/use-toast';

interface RuntimeConfig {
  chainRpc: string;
  trading: {
    buyEthAmount: string;
    sellProfitPct: number;
    sellLossPct: number;
    sellMaxHoldSeconds: number;
    weth?: string;
  };
  include?: { global?: string[] };
  blacklist?: { global?: string[] };
  priorities?: Record<string, number>;
  trackerDefaults?: {
    maxActiveBuyEth?: string;
    trading?: {
      buyEthAmount?: string;
      sellProfitPct?: number;
      sellLossPct?: number;
      sellMaxHoldSeconds?: number;
    };
  };
}

const MOCK_RUNTIME: RuntimeConfig = {
  chainRpc: 'wss://rpc.ankr.com/base/ws',
  trading: {
    buyEthAmount: '0.01',
    sellProfitPct: 100,
    sellLossPct: -30,
    sellMaxHoldSeconds: 3600,
    weth: '0x4200000000000000000000000000000000000006'
  },
  include: { global: [] },
  blacklist: { global: [] },
  priorities: { UniswapV2: 1, UniswapV3: 2, UniswapV4: 3, ApeStore: 4 },
  trackerDefaults: { maxActiveBuyEth: '0.1' }
};

export default function Runtime() {
  const [data, setData] = useState<RuntimeConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api.get('/api/runtime').then(r => setData(r.data)).catch(() => setData(MOCK_RUNTIME));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const r = await api.put('/api/runtime', data);
      setData(r.data);
      toast({ title: 'Runtime saved' });
    } catch (e) {
      toast({ title: 'Failed to save runtime', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (!data) return <Layout title="Runtime Config"><div className="bg-card border border-border rounded-xl p-4">Loading...</div></Layout>;

  return (
    <Layout title="Runtime Config">
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="text-sm text-muted-foreground mb-1">RPC URL</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              value={data.chainRpc}
              onChange={(e) => setData({ ...data, chainRpc: e.target.value })}
            />
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Buy ETH Amount</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              value={data.trading.buyEthAmount}
              onChange={(e) => setData({ ...data, trading: { ...data.trading, buyEthAmount: e.target.value } })}
            />
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Profit %</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              type="number"
              step="0.1"
              value={data.trading.sellProfitPct}
              onChange={(e) => setData({ ...data, trading: { ...data.trading, sellProfitPct: Number(e.target.value) } })}
            />
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Loss %</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              type="number"
              step="0.1"
              value={data.trading.sellLossPct}
              onChange={(e) => setData({ ...data, trading: { ...data.trading, sellLossPct: Number(e.target.value) } })}
            />
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Max Hold (seconds)</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              type="number"
              value={data.trading.sellMaxHoldSeconds}
              onChange={(e) => setData({ ...data, trading: { ...data.trading, sellMaxHoldSeconds: Number(e.target.value) } })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div>
            <div className="text-sm text-muted-foreground mb-1">Global Include (comma-separated addresses)</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              value={(data.include?.global || []).join(',')}
              onChange={(e) => {
                const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                setData({ ...data, include: { ...(data.include || {}), global: parts } });
              }}
            />
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Global Blacklist (comma-separated addresses)</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              value={(data.blacklist?.global || []).join(',')}
              onChange={(e) => {
                const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                setData({ ...data, blacklist: { ...(data.blacklist || {}), global: parts } });
              }}
            />
          </div>
        </div>

        <div className="mt-4">
          <h4 className="font-semibold mb-2">Default Tracker Priorities</h4>
          <div className="flex flex-wrap gap-4">
            {['UniswapV2', 'UniswapV3', 'UniswapV4', 'ApeStore'].map((k) => (
              <div key={k} className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground min-w-[90px]">{k}</label>
                <input
                  className="w-20 px-2 py-1 bg-background border border-border rounded-lg text-foreground"
                  type="number"
                  value={data.priorities?.[k] ?? 0}
                  onChange={(e) => setData({ ...data, priorities: { ...(data.priorities || {}), [k]: Number(e.target.value) } })}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <h4 className="font-semibold mb-2">Tracker Defaults</h4>
          <div className="flex items-center gap-4 mb-2">
            <label className="text-sm text-muted-foreground">maxActiveBuyEth</label>
            <input
              className="w-32 px-2 py-1 bg-background border border-border rounded-lg text-foreground"
              value={data.trackerDefaults?.maxActiveBuyEth || '0'}
              onChange={(e) => setData({ ...data, trackerDefaults: { ...(data.trackerDefaults || {}), maxActiveBuyEth: e.target.value } })}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Override buyEthAmount</div>
              <input
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
                value={data.trackerDefaults?.trading?.buyEthAmount || ''}
                onChange={(e) => setData({
                  ...data,
                  trackerDefaults: {
                    ...(data.trackerDefaults || {}),
                    trading: { ...(data.trackerDefaults?.trading || {}), buyEthAmount: e.target.value }
                  }
                })}
              />
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Override sellProfitPct</div>
              <input
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
                type="number"
                step="0.1"
                value={data.trackerDefaults?.trading?.sellProfitPct ?? ''}
                onChange={(e) => setData({
                  ...data,
                  trackerDefaults: {
                    ...(data.trackerDefaults || {}),
                    trading: { ...(data.trackerDefaults?.trading || {}), sellProfitPct: Number(e.target.value) }
                  }
                })}
              />
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Override sellLossPct</div>
              <input
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
                type="number"
                step="0.1"
                value={data.trackerDefaults?.trading?.sellLossPct ?? ''}
                onChange={(e) => setData({
                  ...data,
                  trackerDefaults: {
                    ...(data.trackerDefaults || {}),
                    trading: { ...(data.trackerDefaults?.trading || {}), sellLossPct: Number(e.target.value) }
                  }
                })}
              />
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Override sellMaxHoldSeconds</div>
              <input
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
                type="number"
                value={data.trackerDefaults?.trading?.sellMaxHoldSeconds ?? ''}
                onChange={(e) => setData({
                  ...data,
                  trackerDefaults: {
                    ...(data.trackerDefaults || {}),
                    trading: { ...(data.trackerDefaults?.trading || {}), sellMaxHoldSeconds: Number(e.target.value) }
                  }
                })}
              />
            </div>
          </div>
        </div>

        <div className="mt-6">
          <button
            className="px-4 py-2 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Layout>
  );
}
