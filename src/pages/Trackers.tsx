import useSWR from 'swr';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Layout } from '@/components/Layout';
import { useToast } from '@/hooks/use-toast';
import { X } from 'lucide-react';

const fetcher = (url: string) => api.get(url).then(r => r.data);

interface TrackerConfig {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  maxTrades?: number;
  maxActiveBuyEth?: string;
  include?: string[];
  blacklist?: string[];
  trading?: {
    buyEthAmount?: string;
    sellProfitPct?: number;
    sellLossPct?: number;
    sellMaxHoldSeconds?: number;
    minWethLiquidity?: string;
    disableHoneypotCheck?: boolean;
  };
}

interface TrackerMetrics {
  id: string;
  name: string;
  metrics?: {
    activeEthWei?: string;
    realizedPnLEthWei?: string;
    tradesCount?: number;
  };
}

interface MetricsData {
  perTracker?: TrackerMetrics[];
}

export default function Trackers() {
  const { data, mutate } = useSWR<TrackerConfig[]>('/api/trackers', fetcher, { refreshInterval: 3000 });
  const { data: metrics } = useSWR<MetricsData>('/api/trackers/metrics', fetcher, { refreshInterval: 3000 });
  const [editing, setEditing] = useState<TrackerConfig | null>(null);
  const [draft, setDraft] = useState<TrackerConfig | null>(null);
  const [testTx, setTestTx] = useState('');
  const [testingTracker, setTestingTracker] = useState('');
  const [testResult, setTestResult] = useState<{ tx: string; results: { trackerId: string; name: string; detected: boolean; processed: boolean; reason?: string; error?: string }[] } | null>(null);
  const [pendingEnable, setPendingEnable] = useState<TrackerConfig | null>(null);
  const [forceBusy, setForceBusy] = useState(false);
  const [sellTxids, setSellTxids] = useState('');
  const [sellPct, setSellPct] = useState(100);
  const [sellBusy, setSellBusy] = useState(false);
  const [logsFor, setLogsFor] = useState<TrackerConfig | null>(null);
  const [logs, setLogs] = useState<{ time: number; phase: string; tx?: string; tokenOut?: string; token?: string; pool?: string; pair?: string; reason?: string }[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const { toast } = useToast();

  const RISKY_DEX_NAMES = ['uniswapv2', 'uniswapv3', 'uniswapv4', 'baseswapv2', 'baseswapv3', 'aerodrome', 'contentcoin', 'zora'];
  const SAFE_PREFIX_BLOCKLIST = ['uniswapv2', 'uniswapv3', 'uniswapv4', 'baseswapv2', 'baseswapv3', 'aerodrome', 'contentcoin', 'zora'];

  const list = useMemo(() => Array.isArray(data) ? data : [], [data]);

  async function enableAll() {
    try {
      await Promise.all(list.filter(t => !t.enabled).map(t => api.post(`/api/trackers/${t.id}/enable`).catch(() => null)));
      toast({ title: 'All trackers enabled' });
      mutate();
    } catch (e) {
      toast({ title: 'Failed enabling all', variant: 'destructive' });
    }
  }

  async function enableSafe() {
    try {
      await Promise.all(list.filter(t => !t.enabled && !SAFE_PREFIX_BLOCKLIST.some(p => (t.name || '').toLowerCase().startsWith(p))).map(t => api.post(`/api/trackers/${t.id}/enable`).catch(() => null)));
      toast({ title: 'Safe trackers enabled' });
      mutate();
    } catch (e) {
      toast({ title: 'Failed enabling safe trackers', variant: 'destructive' });
    }
  }

  async function disableAll() {
    try {
      await Promise.all(list.filter(t => t.enabled).map(t => api.post(`/api/trackers/${t.id}/disable`).catch(() => null)));
      toast({ title: 'All trackers disabled' });
      mutate();
    } catch (e) {
      toast({ title: 'Failed disabling all', variant: 'destructive' });
    }
  }

  async function forceClearAll() {
    try {
      setForceBusy(true);
      const r = await api.post('/api/trades/force-sell-open', {});
      const ok = r?.data?.ok;
      if (ok) {
        const s = r.data.summary || {};
        toast({ title: `Force-sell: ${s.succeeded || 0}/${s.attempted || 0} succeeded` });
      } else {
        toast({ title: 'Force-sell failed', variant: 'destructive' });
      }
    } catch (e) {
      toast({ title: 'Force-sell failed', variant: 'destructive' });
    } finally {
      setForceBusy(false);
    }
  }

  async function forceClearTracker(trackerId: string) {
    try {
      setForceBusy(true);
      const r = await api.post('/api/trades/force-sell-open', { trackerId });
      const ok = r?.data?.ok;
      if (ok) {
        const s = r.data.summary || {};
        toast({ title: `Force-sell (${trackerId}): ${s.succeeded || 0}/${s.attempted || 0} succeeded` });
      } else {
        toast({ title: 'Force-sell failed', variant: 'destructive' });
      }
    } catch (e) {
      toast({ title: 'Force-sell failed', variant: 'destructive' });
    } finally {
      setForceBusy(false);
    }
  }

  async function sellByTx() {
    try {
      setSellBusy(true);
      const body = { txids: sellTxids, amountPct: sellPct };
      const r = await api.post('/api/trades/sell-by-tx', body);
      if (r?.data?.ok) {
        const s = r.data.summary || {};
        toast({ title: `Sell-by-tx: ${s.succeeded || 0}/${s.attempted || 0} succeeded` });
      } else {
        toast({ title: 'Sell-by-tx failed', variant: 'destructive' });
      }
    } catch (e) {
      toast({ title: 'Sell-by-tx failed', variant: 'destructive' });
    } finally {
      setSellBusy(false);
    }
  }

  async function openLogs(tracker: TrackerConfig) {
    setLogsFor(tracker);
    setLogs([]);
    setLogsLoading(true);
    try {
      const r = await api.get('/api/trackerlog', { params: { trackerId: tracker.id, limit: 300 } });
      setLogs(r.data || []);
    } catch (e) {
      toast({ title: 'Failed to load logs', variant: 'destructive' });
    } finally {
      setLogsLoading(false);
    }
  }

  async function enable(id: string) {
    const tracker = list.find(t => t.id === id);
    const nameLc = (tracker?.name || '').toLowerCase();
    if (tracker && RISKY_DEX_NAMES.some(r => nameLc.startsWith(r))) {
      setPendingEnable(tracker);
      return;
    }
    await api.post(`/api/trackers/${id}/enable`);
    toast({ title: 'Tracker enabled' });
    mutate();
  }

  async function confirmEnableRisky() {
    if (!pendingEnable) return;
    const id = pendingEnable.id;
    setPendingEnable(null);
    await api.post(`/api/trackers/${id}/enable`);
    toast({ title: 'Tracker enabled' });
    mutate();
  }

  async function disable(id: string) {
    await api.post(`/api/trackers/${id}/disable`);
    toast({ title: 'Tracker disabled' });
    mutate();
  }

  async function saveConfig() {
    if (!editing || !draft) return;
    await api.put(`/api/trackers/${editing.id}/config`, {
      trading: draft.trading,
      maxActiveBuyEth: draft.maxActiveBuyEth,
      maxTrades: draft.maxTrades,
      include: draft.include,
      blacklist: draft.blacklist,
      priority: draft.priority,
      enabled: draft.enabled,
      name: draft.name
    });
    toast({ title: 'Config saved' });
    setEditing(null);
    setDraft(null);
    mutate();
  }

  const findMetrics = (id: string) => (metrics?.perTracker || []).find(x => x.id === id)?.metrics || { activeEthWei: '0', realizedPnLEthWei: '0', tradesCount: 0 };
  const toEth = (w: string | undefined) => {
    const n = Number(w || 0);
    return isFinite(n) ? (n / 1e18) : 0;
  };

  if (!data) return <Layout title="Trackers"><div className="bg-card border border-border rounded-xl p-4">Loading...</div></Layout>;

  return (
    <Layout title="Trackers">
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex flex-wrap gap-2 mb-4">
          <button className="px-3 py-1 border border-border rounded-lg text-sm hover:bg-muted" onClick={enableSafe}>Enable Safe</button>
          <button className="px-3 py-1 border border-border rounded-lg text-sm hover:bg-muted" onClick={enableAll}>Enable All</button>
          <button className="px-3 py-1 border border-border rounded-lg text-sm hover:bg-muted" onClick={disableAll}>Disable All</button>
          <button className="px-3 py-1 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-60" disabled={forceBusy} onClick={forceClearAll}>
            {forceBusy ? 'Clearing…' : 'Force Clear Open Trades'}
          </button>
        </div>
        <div className="flex items-center gap-2 mb-4">
          <input
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            placeholder="Sell by txid(s): 0xaaa, 0xbbb or whitespace separated"
            value={sellTxids}
            onChange={(e) => setSellTxids(e.target.value)}
          />
          <input
            className="w-20 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            type="number"
            min="1"
            max="100"
            value={sellPct}
            onChange={(e) => setSellPct(Number(e.target.value))}
          />
          <button
            className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-60"
            disabled={sellBusy || !sellTxids.trim()}
            onClick={sellByTx}
          >
            {sellBusy ? 'Selling…' : 'Sell by Tx'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            placeholder="Test tx hash (0x...)"
            value={testTx}
            onChange={(e) => setTestTx(e.target.value)}
          />
          <select
            className="px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            value={testingTracker}
            onChange={(e) => setTestingTracker(e.target.value)}
          >
            <option value="">All trackers</option>
            {list.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button
            className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm"
            onClick={async () => {
              try {
                const body = testingTracker ? { tx: testTx, trackerId: testingTracker } : { tx: testTx };
                const r = await api.post('/api/trackers/test', body);
                setTestResult(r.data);
              } catch (e) {
                toast({ title: 'Test failed', variant: 'destructive' });
              }
            }}
          >
            Run Test
          </button>
        </div>
        {testResult && (
          <div className="mt-4 text-sm">
            <div className="text-muted-foreground">Results for {testResult.tx}:</div>
            <ul className="list-disc pl-6 mt-2">
              {(testResult.results || []).map(r => (
                <li key={r.trackerId}>
                  <span className="font-medium">{r.name}</span>: detected={String(r.detected)}, processed={String(r.processed)}
                  {r.reason && <span className="text-muted-foreground"> ({r.reason})</span>}
                  {r.error && <span className="text-destructive"> ({r.error})</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        {list.map(t => {
          const m = findMetrics(t.id);
          return (
            <div key={t.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border last:border-0 py-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-lg font-semibold">{t.name}</div>
                  <span className={`px-2 py-0.5 rounded text-xs ${t.enabled ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'}`}>
                    {t.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className="px-2 py-0.5 bg-muted rounded text-xs">Priority: {t.priority}</span>
                  <span className="px-2 py-0.5 bg-muted rounded text-xs">Max Trades: {t.maxTrades ?? 0}</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Active: {toEth(m.activeEthWei).toFixed(6)} ETH | Realized: {toEth(m.realizedPnLEthWei).toFixed(6)} ETH | Trades: {m.tradesCount ?? 0}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button className="px-3 py-1 border border-border rounded-lg text-sm hover:bg-muted" onClick={() => { setEditing(t); setDraft(JSON.parse(JSON.stringify(t))); }}>Edit Config</button>
                <button className="px-3 py-1 border border-border rounded-lg text-sm hover:bg-muted" onClick={() => openLogs(t)}>View Logs</button>
                <button className="px-3 py-1 border border-border rounded-lg text-sm hover:bg-muted disabled:opacity-60" disabled={forceBusy} onClick={() => forceClearTracker(t.id)}>Force Clear</button>
                {t.enabled ? (
                  <button className="px-3 py-1 bg-primary text-primary-foreground rounded-lg text-sm" onClick={() => disable(t.id)}>Disable</button>
                ) : (
                  <button className="px-3 py-1 bg-primary text-primary-foreground rounded-lg text-sm" onClick={() => enable(t.id)}>Enable</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setEditing(null); setDraft(null); }} />
          <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl p-4 max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Edit Config — {editing.name}</h3>
              <button className="p-1 hover:bg-muted rounded" onClick={() => { setEditing(null); setDraft(null); }}><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Priority</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Max Active Buy (ETH)</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" value={draft.maxActiveBuyEth || '0'} onChange={(e) => setDraft({ ...draft, maxActiveBuyEth: e.target.value })} />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Max Trades (0 = unlimited)</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" type="number" min="0" value={draft.maxTrades ?? 0} onChange={(e) => setDraft({ ...draft, maxTrades: Number(e.target.value) })} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Include (comma-separated)</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" value={(draft.include || []).join(',')} onChange={(e) => setDraft({ ...draft, include: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Blacklist (comma-separated)</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" value={(draft.blacklist || []).join(',')} onChange={(e) => setDraft({ ...draft, blacklist: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Trading.buyEthAmount</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" value={draft.trading?.buyEthAmount || ''} onChange={(e) => setDraft({ ...draft, trading: { ...(draft.trading || {}), buyEthAmount: e.target.value } })} />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Trading.sellProfitPct</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" type="number" step="0.1" value={draft.trading?.sellProfitPct ?? ''} onChange={(e) => setDraft({ ...draft, trading: { ...(draft.trading || {}), sellProfitPct: Number(e.target.value) } })} />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Trading.sellLossPct</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" type="number" step="0.1" value={draft.trading?.sellLossPct ?? ''} onChange={(e) => setDraft({ ...draft, trading: { ...(draft.trading || {}), sellLossPct: Number(e.target.value) } })} />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Trading.sellMaxHoldSeconds</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" type="number" value={draft.trading?.sellMaxHoldSeconds ?? ''} onChange={(e) => setDraft({ ...draft, trading: { ...(draft.trading || {}), sellMaxHoldSeconds: Number(e.target.value) } })} />
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Trading.minWethLiquidity</div>
                <input className="w-full px-3 py-2 bg-background border border-border rounded-lg" value={draft.trading?.minWethLiquidity || ''} onChange={(e) => setDraft({ ...draft, trading: { ...(draft.trading || {}), minWethLiquidity: e.target.value } })} />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input id="hp" type="checkbox" checked={!!draft.trading?.disableHoneypotCheck} onChange={(e) => setDraft({ ...draft, trading: { ...(draft.trading || {}), disableHoneypotCheck: e.target.checked } })} />
                <label htmlFor="hp" className="text-sm text-muted-foreground">Disable Honeypot Check</label>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button className="px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted" onClick={() => { setEditing(null); setDraft(null); }}>Cancel</button>
              <button className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm" onClick={saveConfig}>Save Config</button>
            </div>
          </div>
        </div>
      )}

      {logsFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setLogsFor(null); setLogs([]); }} />
          <div className="relative w-full max-w-3xl bg-card border border-border rounded-xl p-4 max-h-[80vh] overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Logs — {logsFor.name}</h3>
              <div className="flex items-center gap-2">
                <button className="px-3 py-1 border border-border rounded-lg text-sm hover:bg-muted" onClick={() => openLogs(logsFor)}>Refresh</button>
                <button className="p-1 hover:bg-muted rounded" onClick={() => { setLogsFor(null); setLogs([]); }}><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="bg-background border border-border rounded-lg p-2 overflow-auto max-h-[65vh] text-xs">
              {logsLoading && <div className="text-muted-foreground">Loading...</div>}
              {!logsLoading && logs.length === 0 && <div className="text-muted-foreground">No logs</div>}
              {!logsLoading && logs.length > 0 && (
                <ul className="space-y-2">
                  {logs.slice().reverse().map((e, idx) => (
                    <li key={idx} className="border-b border-border pb-2 last:border-0">
                      <div>
                        <span className="text-muted-foreground">{new Date(e.time).toLocaleTimeString()}</span>
                        <span className="ml-2 px-1 py-0.5 bg-muted rounded text-xs">{e.phase}</span>
                        {e.tx && <span className="ml-2">tx: <span className="font-mono">{e.tx}</span></span>}
                        {e.tokenOut && <span className="ml-2">token: <span className="font-mono">{e.tokenOut}</span></span>}
                        {e.token && !e.tokenOut && <span className="ml-2">token: <span className="font-mono">{e.token}</span></span>}
                        {e.pool && <span className="ml-2">pool: <span className="font-mono">{e.pool}</span></span>}
                        {e.pair && <span className="ml-2">pair: <span className="font-mono">{e.pair}</span></span>}
                        {e.reason && <span className="ml-2 text-destructive">reason: {e.reason}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {pendingEnable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setPendingEnable(null)} />
          <div className="relative w-full max-w-md bg-card border border-border rounded-xl p-4">
            <h3 className="text-lg font-semibold mb-2">High Risk DEX</h3>
            <p className="text-sm text-muted-foreground mb-4">
              <span className="font-semibold text-foreground">{pendingEnable.name}</span> is considered a <span className="text-destructive font-medium">HIGH RISK</span> venue to trade on.
              New listings can be illiquid, manipulated, or outright scams. Proceed only with very small test amounts.
            </p>
            <ul className="text-xs list-disc pl-5 text-muted-foreground space-y-1 mb-4">
              <li>Liquidity may be pulled instantly (rug risk)</li>
              <li>Tokens may have transfer taxes / honeypot behavior</li>
              <li>Slippage & MEV can cause large losses</li>
            </ul>
            <div className="flex items-center justify-end gap-2">
              <button className="px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted" onClick={() => setPendingEnable(null)}>Cancel</button>
              <button className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm" onClick={confirmEnableRisky}>I Understand, Enable</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
