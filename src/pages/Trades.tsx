import { useEffect, useMemo, useState, useCallback } from 'react';
import { Layout } from '@/components/Layout';
import { getSocket } from '@/lib/socket';
import { api } from '@/lib/api';

interface TokenMeta {
  symbol?: string;
  name?: string;
}

interface TradeRow {
  id: string;
  token: string;
  pnlPct: number | null;
  quotedEthOut: string | null;
  timeLeftMs: number | null;
  startedAt: number | null;
  maxHoldMs: number | null;
  dex: string | null;
  trackerId: string | null;
  trackerName: string | null;
  pool: string | null;
  manual: boolean;
  last: number;
}

interface HistoryTrade {
  id: string;
  token?: string;
  startedAt?: number;
  finishedAt?: number;
  dex?: string;
  trackerId?: string;
  trackerName?: string;
  pool?: string;
  status?: string;
  buyTx?: string;
  sellTx?: string;
  creator?: string;
  creatorTokens?: number;
  txs?: { time: number; action?: string; phase: string; hash?: string }[];
}

export default function Trades() {
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [history, setHistory] = useState<HistoryTrade[]>([]);
  const [detail, setDetail] = useState<HistoryTrade | null>(null);
  const [loadingHist, setLoadingHist] = useState(true);
  const [hasLoadedHist, setHasLoadedHist] = useState(false);
  const [refreshingHist, setRefreshingHist] = useState(false);
  const [query, setQuery] = useState('');
  const [filterDex, setFilterDex] = useState('');
  const [filterTrackerName, setFilterTrackerName] = useState('');
  const [trackers, setTrackers] = useState<{ id: string; name: string }[]>([]);
  const [defaultMaxHoldMs, setDefaultMaxHoldMs] = useState(3600 * 1000);
  const [meta, setMeta] = useState<Record<string, TokenMeta>>({});
  const [tradeModal, setTradeModal] = useState<{ trackerId: string | null; token: string } | null>(null);

  const KNOWN_DEXES = useMemo(() => [
    'UniswapV2', 'UniswapV3', 'UniswapV4', 'BaseSwapV2', 'BaseSwapV3', 'Aerodrome', 'ClankerV4', 'ZoraV4', 'ContentCoinV4', 'KingOfApes', 'ApeStore'
  ], []);

  const ensureTokenRow = useCallback((token: string, extra: Partial<TradeRow> = {}) => {
    if (!token) return;
    setRows((arr) => {
      const id = token.toLowerCase();
      const idx = arr.findIndex(x => x.id === id);
      const patch: Partial<TradeRow> = {};
      if (extra.dex !== undefined) patch.dex = extra.dex;
      if (extra.trackerId !== undefined) patch.trackerId = extra.trackerId;
      if (extra.trackerName !== undefined) patch.trackerName = extra.trackerName;
      if (extra.pool !== undefined) patch.pool = extra.pool;
      if (extra.manual !== undefined) patch.manual = extra.manual;
      if (extra.pnlPct !== undefined) patch.pnlPct = extra.pnlPct;
      if (extra.quotedEthOut !== undefined) patch.quotedEthOut = extra.quotedEthOut;
      if (extra.timeLeftMs !== undefined) patch.timeLeftMs = extra.timeLeftMs;
      if (extra.startedAt !== undefined) patch.startedAt = extra.startedAt;
      if (extra.maxHoldMs !== undefined) patch.maxHoldMs = extra.maxHoldMs;

      if (idx >= 0) {
        const next = arr.slice();
        next[idx] = { ...next[idx], ...patch, last: Date.now() };
        return next;
      }
      const entry: TradeRow = {
        id,
        token,
        pnlPct: patch.pnlPct ?? null,
        quotedEthOut: patch.quotedEthOut ?? null,
        timeLeftMs: patch.timeLeftMs ?? null,
        startedAt: patch.startedAt ?? Date.now(),
        maxHoldMs: patch.maxHoldMs ?? null,
        dex: patch.dex ?? null,
        trackerId: patch.trackerId ?? null,
        trackerName: patch.trackerName ?? null,
        pool: patch.pool ?? null,
        manual: patch.manual ?? false,
        last: Date.now(),
      };
      return [entry, ...arr].slice(0, 100);
    });
  }, []);

  const removeTokenRow = useCallback((token: string) => {
    if (!token) return;
    setRows((arr) => arr.filter(x => x.id !== token.toLowerCase()));
  }, []);

  const loadTrades = useCallback(async () => {
    const initial = !hasLoadedHist;
    if (initial) setLoadingHist(true); else setRefreshingHist(true);
    try {
      const { data } = await api.get('/api/trades?page=0&pageSize=50');
      const items = data.items || [];
      setHistory(items);
      items.forEach((t: HistoryTrade) => {
        if (t && t.status === 'open' && t.token) {
          ensureTokenRow(t.token, {
            dex: t.dex || null,
            trackerId: t.trackerId || null,
            trackerName: t.trackerName || null,
            pool: t.pool || null,
            startedAt: t.startedAt || null,
          });
        }
      });
      if (initial) setHasLoadedHist(true);
    } catch (_) {
      // ignore
    } finally {
      if (initial) setLoadingHist(false); else setRefreshingHist(false);
    }
  }, [hasLoadedHist, ensureTokenRow]);

  useEffect(() => { loadTrades(); }, [loadTrades]);

  useEffect(() => {
    const s = getSocket();
    const schedule = (() => {
      let last = 0;
      return () => {
        const now = Date.now();
        if (now - last < 2000) return;
        last = now;
        loadTrades();
      };
    })();
    const onBuy = (evt: { token?: string; tokenOut?: string; dex?: string; trackerId?: string; trackerName?: string; pool?: string; pair?: string }) => {
      const tok = evt.token || evt.tokenOut;
      if (tok) ensureTokenRow(tok, { dex: evt?.dex || null, trackerId: evt?.trackerId || null, trackerName: evt?.trackerName || null, pool: evt?.pool || evt?.pair || null });
      schedule();
    };
    const onSell = (evt: { token?: string; tokenOut?: string; tokenIn?: string }) => {
      const tok = evt.token || evt.tokenOut || evt.tokenIn;
      if (tok) removeTokenRow(tok);
      schedule();
    };
    s.on('trade:buy', onBuy);
    s.on('trade:sell', onSell);
    const iv = setInterval(loadTrades, 15000);
    return () => { s.off('trade:buy', onBuy); s.off('trade:sell', onSell); clearInterval(iv); };
  }, [loadTrades, ensureTokenRow, removeTokenRow]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/trackers');
        if (Array.isArray(data)) setTrackers(data);
      } catch (_) {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/runtime');
        const secs = Number(data?.trading?.sellMaxHoldSeconds);
        if (Number.isFinite(secs) && secs > 0) setDefaultMaxHoldMs(secs * 1000);
      } catch (_) {}
    })();
  }, []);

  useEffect(() => {
    const s = getSocket();
    const onMon = (m: { token?: string; tokenOut?: string; tokenIn?: string; pnlPct?: number; pnl?: number; quotedEthOut?: string; outEth?: number; timeLeftMs?: number; startedAt?: number; maxHoldMs?: number; dex?: string; trackerId?: string; trackerName?: string; pool?: string; pair?: string }) => {
      const tok = m.token || m.tokenOut || m.tokenIn;
      if (!tok) return;
      setRows((arr) => {
        const id = tok.toLowerCase();
        const next = arr.slice();
        const idx = next.findIndex(x => x.id === id);
        const pnlPct = (typeof m.pnlPct === 'number') ? m.pnlPct : (typeof m.pnl === 'number' ? m.pnl : null);
        const quotedEthOut = (m.quotedEthOut != null) ? m.quotedEthOut : (m.outEth != null ? String(Math.floor(Number(m.outEth) * 1e18)) : null);
        const rec: TradeRow = {
          id,
          token: tok,
          pnlPct,
          quotedEthOut,
          timeLeftMs: m.timeLeftMs ?? null,
          startedAt: m.startedAt ?? null,
          maxHoldMs: m.maxHoldMs ?? null,
          dex: m.dex ?? null,
          trackerId: m.trackerId ?? null,
          trackerName: m.trackerName ?? null,
          pool: m.pool || m.pair || null,
          manual: false,
          last: Date.now(),
        };
        if (idx >= 0) {
          next[idx] = { ...next[idx], ...rec };
        } else {
          next.unshift(rec);
        }
        return next.slice(0, 100);
      });
    };
    s.on('trade:monitor', onMon);
    return () => { s.off('trade:monitor', onMon); };
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      setRows((arr) => {
        let changed = false;
        const now = Date.now();
        const out = arr.map(r => {
          if (!r) return r;
          if (r.startedAt && (r.timeLeftMs == null || r.maxHoldMs == null)) {
            const max = r.maxHoldMs != null ? r.maxHoldMs : defaultMaxHoldMs;
            const tl = Math.max(0, max - (now - r.startedAt));
            changed = true;
            return { ...r, timeLeftMs: tl, maxHoldMs: r.maxHoldMs != null ? r.maxHoldMs : max };
          }
          return r;
        });
        return changed ? out : arr;
      });
    }, 5000);
    return () => clearInterval(iv);
  }, [defaultMaxHoldMs]);

  const ensureMeta = useCallback(async (addr: string) => {
    if (!addr) return null;
    const key = addr.toLowerCase();
    if (meta[key]) return meta[key];
    try {
      const { data } = await api.get(`/api/tokens/${addr}`);
      setMeta((m) => ({ ...m, [key]: data }));
      return data;
    } catch (_) { return null; }
  }, [meta]);

  const dexOptions = useMemo(() => {
    const s = new Set(KNOWN_DEXES);
    rows.forEach(r => { if (r.dex) s.add(r.dex); });
    history.forEach(t => { if (t.dex) s.add(t.dex); });
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [rows, history, KNOWN_DEXES]);

  const trackerOptions = useMemo(() => {
    const set = new Set<string>();
    trackers.forEach(t => { if (t?.name) set.add(t.name); });
    rows.forEach(r => { if (r?.trackerName) set.add(r.trackerName); });
    history.forEach(h => { if (h?.trackerName) set.add(h.trackerName); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [trackers, rows, history]);

  const matchesQuery = (address: string, extraText = '') => {
    const q = (query || '').trim().toLowerCase();
    if (!q) return true;
    const addr = (address || '').toLowerCase();
    if (addr.includes(q)) return true;
    const m = meta[addr];
    if (m && ((m.symbol || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))) return true;
    if ((extraText || '').toLowerCase().includes(q)) return true;
    return false;
  };

  const viewRows = useMemo(() => {
    const filtered = rows.filter(r => {
      if (filterDex && (r.dex || '') !== filterDex) return false;
      if (filterTrackerName && (r.trackerName || '') !== filterTrackerName) return false;
      return matchesQuery(r.token);
    });
    filtered.sort((a, b) => {
      const pa = (typeof a.pnlPct === 'number') ? a.pnlPct : -Infinity;
      const pb = (typeof b.pnlPct === 'number') ? b.pnlPct : -Infinity;
      return pb - pa;
    });
    return filtered;
  }, [rows, filterDex, filterTrackerName, query, meta]);

  const viewHistory = useMemo(() => {
    return history.filter(t => {
      if (filterDex && (t.dex || '') !== filterDex) return false;
      if (filterTrackerName && (t.trackerName || '') !== filterTrackerName) return false;
      return matchesQuery(t.token || '', `${t.trackerName || ''} ${t.dex || ''}`);
    });
  }, [history, filterDex, filterTrackerName, query, meta]);

  const fmtPct = (p: number | null) => p == null ? '—' : (p * 100).toFixed(2) + '%';
  const fmtTime = (ms: number | null) => ms == null ? '—' : `${Math.floor(ms / 1000)}s`;

  return (
    <Layout title="Live Trades">
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-2 mb-4">
          <div className="flex-1">
            <div className="text-xs text-muted-foreground mb-1">Search token (address / name / symbol)</div>
            <input
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              placeholder="0x... or PEPE"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">DEX</div>
            <select
              className="px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              value={filterDex}
              onChange={(e) => setFilterDex(e.target.value)}
            >
              <option value="">All DEXes</option>
              {dexOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Tracker</div>
            <select
              className="px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              value={filterTrackerName}
              onChange={(e) => setFilterTrackerName(e.target.value)}
            >
              <option value="">All trackers</option>
              {trackerOptions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border sticky top-0 bg-card">
              <tr>
                <th className="text-left p-2">Token</th>
                <th className="text-left p-2">PnL</th>
                <th className="text-left p-2">Quoted ETH Out</th>
                <th className="text-left p-2">Time Left</th>
                <th className="text-left p-2">Started</th>
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {viewRows.map(r => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/50">
                  <td className="p-2">
                    <TokenCell address={r.token} trackerName={r.trackerName} dex={r.dex} pool={r.pool} meta={meta} ensureMeta={ensureMeta} />
                  </td>
                  <td className={`p-2 ${r.pnlPct && r.pnlPct > 0 ? 'text-green-500' : r.pnlPct && r.pnlPct < 0 ? 'text-red-500' : ''}`}>{fmtPct(r.pnlPct)}</td>
                  <td className="p-2">{r.quotedEthOut ? (Number(r.quotedEthOut) / 1e18).toFixed(6) : '—'}</td>
                  <td className="p-2">{fmtTime(r.timeLeftMs)}</td>
                  <td className="p-2">{r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '—'}</td>
                  <td className="p-2">
                    <button
                      className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs"
                      onClick={() => setTradeModal({ trackerId: r.trackerId, token: r.token })}
                    >
                      Trade
                    </button>
                  </td>
                </tr>
              ))}
              {viewRows.length === 0 && (
                [...Array(3)].map((_, i) => (
                  <tr key={`sk-${i}`}>
                    <td colSpan={6} className="p-2">
                      <div className="animate-pulse h-4 bg-muted rounded" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold">Recent Trades</h3>
            {hasLoadedHist && refreshingHist && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                Updating…
              </span>
            )}
          </div>
          <button
            className="px-3 py-1 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-60"
            disabled={refreshingHist && hasLoadedHist}
            onClick={loadTrades}
          >
            Refresh
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border sticky top-0 bg-card">
              <tr>
                <th className="text-left p-2">Time</th>
                <th className="text-left p-2">Token</th>
                <th className="text-left p-2">DEX</th>
                <th className="text-left p-2">Tracker</th>
                <th className="text-left p-2">Creator</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Buy Tx</th>
                <th className="text-left p-2">Sell Tx</th>
                <th className="text-left p-2"></th>
              </tr>
            </thead>
            <tbody>
              {!hasLoadedHist && loadingHist ? (
                [...Array(5)].map((_, i) => (
                  <tr key={`hsk-${i}`}>
                    <td colSpan={9} className="p-2"><div className="animate-pulse h-4 bg-muted rounded" /></td>
                  </tr>
                ))
              ) : (
                <>
                  {viewHistory.map(t => (
                    <tr key={t.id} className="border-b border-border hover:bg-muted/50">
                      <td className="p-2">{t.startedAt ? new Date(t.startedAt).toLocaleString() : '—'}</td>
                      <td className="p-2">
                        {t.token ? (
                          <TokenCell address={t.token} trackerName={null} dex={t.dex || null} pool={t.pool || null} meta={meta} ensureMeta={ensureMeta} />
                        ) : '—'}
                      </td>
                      <td className="p-2">{t.dex}</td>
                      <td className="p-2" title={t.trackerId}>{t.trackerName}</td>
                      <td className="p-2">
                        {t.creator ? (
                          <a className="text-primary font-mono text-xs hover:underline" href={`https://basescan.org/address/${t.creator}`} target="_blank" rel="noreferrer">
                            {t.creator.slice(0, 6)}...{t.creator.slice(-4)}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="p-2">{t.status}</td>
                      <td className="p-2">{t.buyTx ? <a className="text-primary hover:underline" href={`https://basescan.org/tx/${t.buyTx}`} target="_blank" rel="noreferrer">view</a> : '—'}</td>
                      <td className="p-2">{t.sellTx ? <a className="text-primary hover:underline" href={`https://basescan.org/tx/${t.sellTx}`} target="_blank" rel="noreferrer">view</a> : '—'}</td>
                      <td className="p-2">
                        <button
                          className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs"
                          onClick={async () => {
                            try {
                              const { data } = await api.get(`/api/trades/${t.id}`);
                              setDetail(data);
                            } catch (_) {}
                          }}
                        >
                          Info
                        </button>
                      </td>
                    </tr>
                  ))}
                  {viewHistory.length === 0 && (
                    <tr><td colSpan={9} className="p-2 text-muted-foreground">No trades</td></tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl p-4 max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-4">Trade Info</h3>
            <p className="text-sm mb-1">ID: <span className="font-mono">{detail.id}</span></p>
            <p className="text-sm mb-1">Tracker: {detail.trackerName} <span className="font-mono text-xs">({detail.trackerId})</span></p>
            <p className="text-sm mb-1">DEX: {detail.dex}</p>
            <p className="text-sm mb-1">Token: {detail.token}</p>
            <p className="text-sm mb-1">Started: {detail.startedAt ? new Date(detail.startedAt).toLocaleString() : '—'}</p>
            <p className="text-sm mb-4">Finished: {detail.finishedAt ? new Date(detail.finishedAt).toLocaleString() : '—'}</p>
            <h4 className="font-semibold mb-2">Transactions</h4>
            <ul className="list-disc pl-6 text-sm max-h-64 overflow-auto">
              {(detail.txs || []).map((x, i) => (
                <li key={i}>
                  <span className="font-mono">{new Date(x.time).toLocaleString()}</span>
                  {' '}[{x.action || 'tx'}:{x.phase}] {x.hash ? <a className="text-primary hover:underline" href={`https://basescan.org/tx/${x.hash}`} target="_blank" rel="noreferrer">{x.hash.slice(0, 10)}…</a> : ''}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <button className="px-3 py-2 bg-primary text-primary-foreground rounded-lg" onClick={() => setDetail(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {tradeModal && (
        <TradeModal
          trackerId={tradeModal.trackerId}
          token={tradeModal.token}
          onClose={() => setTradeModal(null)}
          onAfter={() => { setTradeModal(null); loadTrades(); }}
        />
      )}
    </Layout>
  );
}

function TokenCell({
  address,
  trackerName,
  meta,
  ensureMeta,
  dex,
  pool,
}: {
  address: string;
  trackerName: string | null;
  meta: Record<string, TokenMeta>;
  ensureMeta: (addr: string) => Promise<TokenMeta | null>;
  dex: string | null;
  pool: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const key = (address || '').toLowerCase();
  const m = meta[key];

  useEffect(() => {
    if (address && !m && !loading) {
      setLoading(true);
      Promise.resolve(ensureMeta(address)).finally(() => setLoading(false));
    }
  }, [address, m, loading, ensureMeta]);

  if (!address) return <span>—</span>;

  const short = address.slice(0, 10) + '…';
  const dexscreenerUrl = address ? `https://dexscreener.com/base/${address}` : null;
  const uniswapUrl = pool ? `https://app.uniswap.org/explore/pools/base/${pool}` : (address ? `https://app.uniswap.org/explore/tokens/base/${address}` : null);
  const uniswapLabel = (dex || '').toLowerCase().includes('baseswap') ? 'BaseSwap' : 'Uniswap';

  return (
    <div className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        {m ? (
          <a className="text-primary hover:underline inline-flex items-center gap-1" href={`https://basescan.org/token/${address}`} target="_blank" rel="noreferrer">
            <span className="max-w-[160px] truncate" title={m.symbol}>{m.symbol}</span>
            <span className="text-muted-foreground font-mono">{short}</span>
          </a>
        ) : (
          <a className="text-primary hover:underline" href={`https://basescan.org/token/${address}`} target="_blank" rel="noreferrer">{short}</a>
        )}
        {trackerName && <span className="text-muted-foreground max-w-[180px] truncate">{trackerName}</span>}
      </span>
      {m && m.name && <span className="text-xs text-muted-foreground max-w-[220px] truncate">{m.name}</span>}
      <div className="flex flex-col gap-1 text-xs">
        {dexscreenerUrl && <a className="text-primary hover:underline" href={dexscreenerUrl} target="_blank" rel="noreferrer">📊 DexScreener</a>}
        {uniswapUrl && <a className="text-primary hover:underline" href={uniswapUrl} target="_blank" rel="noreferrer">🦄 {uniswapLabel}</a>}
      </div>
    </div>
  );
}

function TradeModal({ trackerId, token, onClose, onAfter }: { trackerId: string | null; token: string; onClose: () => void; onAfter: () => void }) {
  const [amt, setAmt] = useState('0.01');
  const [pct, setPct] = useState('1');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ type: string; tx?: string; error?: string } | null>(null);

  const doBuy = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { data } = await api.post('/api/trades/manual/buy', { trackerId, token, amountEth: Number(amt) });
      setResult({ type: 'buy', tx: data?.tx || null });
    } catch (e: unknown) {
      setResult({ type: 'buy', error: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'failed' });
    }
    setBusy(false);
  };

  const doSell = async () => {
    setBusy(true);
    setResult(null);
    try {
      const pctNum = Number(pct);
      const pctClamped = Math.max(0, Math.min(100, Number.isFinite(pctNum) ? pctNum : 0));
      const { data } = await api.post('/api/trades/manual/sell', { trackerId, token, amountPct: pctClamped });
      setResult({ type: 'sell', tx: data?.tx || null });
    } catch (e: unknown) {
      setResult({ type: 'sell', error: (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'failed' });
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative w-full max-w-md bg-card border border-border rounded-xl p-4" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-2">Manual Trade</h3>
        <p className="font-mono text-xs mb-4">Token: {(token || '').slice(0, 10)}…</p>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="w-28 text-sm">Buy amount (ETH)</label>
            <input className="flex-1 px-3 py-2 bg-background border border-border rounded-lg" value={amt} onChange={(e) => setAmt(e.target.value)} />
            <button className="px-3 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-60" disabled={busy} onClick={doBuy}>Buy</button>
          </div>
          <div className="flex items-center gap-2">
            <label className="w-28 text-sm">Sell percent (0-100)</label>
            <input className="flex-1 px-3 py-2 bg-background border border-border rounded-lg" value={pct} onChange={(e) => setPct(e.target.value)} />
            <button className="px-3 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-60" disabled={busy} onClick={doSell}>Sell</button>
          </div>
          {busy && <div className="text-sm text-muted-foreground">Submitting…</div>}
          {result && (
            <div className="text-sm">
              {result.error ? (
                <div className="text-destructive">{result.type.toUpperCase()} failed: {result.error}</div>
              ) : (
                <div className="text-green-500">{result.type.toUpperCase()} submitted {result.tx ? (
                  <> — <a className="text-primary hover:underline" href={`https://basescan.org/tx/${result.tx}`} target="_blank" rel="noreferrer">{result.tx.slice(0, 10)}…</a></>
                ) : null}</div>
              )}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button className="px-3 py-2 bg-primary text-primary-foreground rounded-lg" onClick={onAfter}>Close</button>
        </div>
      </div>
    </div>
  );
}
