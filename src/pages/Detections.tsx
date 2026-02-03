import { useEffect, useMemo, useRef, useState } from 'react';
import { Layout } from '@/components/Layout';
import { getSocket } from '@/lib/socket';
import { api } from '@/lib/api';

interface Detection {
  tx: string;
  trackerId: string;
  tracker?: string;
  version?: string;
  token?: string;
  currency1?: string;
  token1?: string;
  pool?: string;
  pair?: string;
  creator?: string;
  creatorTokens?: number;
  pass?: boolean;
  reason?: string;
  ts?: number;
  enabled?: boolean;
  hasToken?: boolean;
  dexscreener?: string;
  uniswapLink?: string;
  dex?: string;
  tokenSymbol?: string;
  tokenName?: string;
}

export default function Detections() {
  const [items, setItems] = useState<Detection[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [tokenFilter, setTokenFilter] = useState('withTokens');
  const [isPaused, setIsPaused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/detections?limit=100');
        if (Array.isArray(data?.items)) setItems(data.items);
      } catch (_) {
        // Add mock data when API is unavailable
        setItems([
          { tx: '0x1234567890abcdef1234567890abcdef12345678', trackerId: 'clankerv4', tracker: 'ClankerV4', token: '0xabcd1234567890abcdef1234567890abcdef1234', pool: '0x9999888877776666', pass: true, ts: Date.now() - 60000, hasToken: true, tokenSymbol: 'PEPE', tokenName: 'Pepe Token', creator: '0x1111222233334444', creatorTokens: 5 },
          { tx: '0xfedcba0987654321fedcba0987654321fedcba09', trackerId: 'uniswapv3', tracker: 'UniswapV3', token: '0x5678abcdef1234567890abcdef1234567890abcd', pool: '0x8888777766665555', pass: false, reason: 'low-liquidity', ts: Date.now() - 120000, hasToken: true, tokenSymbol: 'DOGE', tokenName: 'Doge Coin', creator: '0x2222333344445555', creatorTokens: 3 },
          { tx: '0xaaabbbccc111222333444555666777888999000', trackerId: 'baseswapv3', tracker: 'BaseSwapV3', token: '0xdef1234567890abcdef1234567890abcdef12345', pool: '0x7777666655554444', pass: true, ts: Date.now() - 180000, hasToken: true, tokenSymbol: 'SHIB', tokenName: 'Shiba Inu', creator: '0x3333444455556666', creatorTokens: 8 },
        ]);
      }
    })();

    const s = getSocket();
    const onDet = (evt: Detection) => {
      if (isPaused) return;
      
      setItems((arr) => {
        const seen = new Set<string>();
        const merged = [{ ...evt }, ...arr].filter((it) => {
          if (!it || !it.tx || !it.trackerId) return false;
          const key = `${it.tx}:${it.trackerId}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return merged.slice(0, 500);
      });
      try { listRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' }); } catch (_) {}
    };
    s.on('detection', onDet);
    return () => { s.off('detection', onDet); };
  }, [isPaused]);

  const filtered = useMemo(() => {
    let result = items;
    if (statusFilter === 'pass') result = result.filter(it => it.pass);
    else if (statusFilter === 'fail') result = result.filter(it => !it.pass);
    if (tokenFilter === 'withTokens') result = result.filter(it => it.hasToken);
    return result;
  }, [items, statusFilter, tokenFilter]);

  return (
    <Layout title="Detections">
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <h3 className="m-0 text-lg font-semibold">All Pool Detections</h3>
            <button
              className={`px-3 py-1 text-sm rounded-lg ${isPaused ? 'bg-yellow-500/20 text-yellow-500' : 'bg-green-500/20 text-green-500'}`}
              onClick={() => setIsPaused(!isPaused)}
            >
              {isPaused ? '▶️ Resume' : '⏸️ Pause'}
            </button>
          </div>
          <div className="flex gap-4">
            <div className="flex gap-2">
              <button
                className={`px-3 py-1 text-sm rounded-lg ${statusFilter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                onClick={() => setStatusFilter('all')}
              >
                All ({items.length})
              </button>
              <button
                className={`px-3 py-1 text-sm rounded-lg ${statusFilter === 'fail' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                onClick={() => setStatusFilter('fail')}
              >
                Filtered ({items.filter(it => !it.pass).length})
              </button>
            </div>
            <div className="flex gap-2 border-l border-border pl-4">
              <button
                className={`px-3 py-1 text-sm rounded-lg ${tokenFilter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                onClick={() => setTokenFilter('all')}
              >
                All Detections
              </button>
              <button
                className={`px-3 py-1 text-sm rounded-lg ${tokenFilter === 'withTokens' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                onClick={() => setTokenFilter('withTokens')}
              >
                With Tokens ({items.filter(it => it.hasToken).length})
              </button>
            </div>
          </div>
        </div>
        
        <div ref={listRef} className="max-h-[70vh] overflow-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted sticky top-0">
              <tr>
                <th className="text-left p-2">Time</th>
                <th className="text-left p-2">DEX</th>
                <th className="text-left p-2">Token</th>
                <th className="text-left p-2">Creator</th>
                <th className="text-left p-2">Pool/Pair</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Links</th>
                <th className="text-left p-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, idx) => {
                const token = e.token || e.currency1 || e.token1;
                const pool = e.pool || e.pair;
                const hasToken = e.hasToken !== false;
                return (
                  <tr key={`${e.tx}-${e.trackerId}-${idx}`} className="border-b border-border hover:bg-muted/50">
                    <td className="p-2 whitespace-nowrap text-xs">
                      {new Date(e.ts || Date.now()).toLocaleTimeString()}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div>
                          <div className="text-sm font-medium">{e.tracker || 'Unknown'}</div>
                          {e.version && <div className="text-xs text-muted-foreground">{e.version}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="p-2">
                      {token ? (
                        <div>
                          <div className="font-mono text-xs">{token.slice(0, 6)}...{token.slice(-4)}</div>
                          {hasToken && e.tokenSymbol && <div className="text-xs font-semibold">{e.tokenSymbol}</div>}
                          {hasToken && e.tokenName && <div className="text-xs text-muted-foreground">{e.tokenName}</div>}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      {e.creator ? (
                        <div>
                          <a
                            className="text-primary font-mono text-xs hover:underline"
                            href={`https://basescan.org/address/${e.creator}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {e.creator.slice(0, 6)}...{e.creator.slice(-4)}
                          </a>
                          {typeof e.creatorTokens !== 'undefined' && (
                            <div className="text-xs text-muted-foreground mt-1">{e.creatorTokens} total</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      {pool ? (
                        <div className="font-mono text-xs">{pool.slice(0, 6)}...{pool.slice(-4)}</div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      {e.pass ? (
                        <span className="px-2 py-0.5 bg-green-500/20 text-green-500 rounded text-xs">PASS</span>
                      ) : (
                        <div>
                          <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-500 rounded text-xs">FILTERED</span>
                          {e.reason && <div className="text-xs text-muted-foreground mt-1">{e.reason.replace(/-/g, ' ')}</div>}
                        </div>
                      )}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        {e.dexscreener && token && (
                          <a className="text-primary text-xs hover:underline" href={e.dexscreener} target="_blank" rel="noreferrer">
                            📊 DexScreener
                          </a>
                        )}
                        {e.uniswapLink && (
                          <a className="text-primary text-xs hover:underline" href={e.uniswapLink} target="_blank" rel="noreferrer">
                            🦄 {e.dex === 'BaseSwap' ? 'BaseSwap' : 'Uniswap'}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="p-2">
                      <a
                        className="text-primary text-xs font-mono hover:underline"
                        href={`https://basescan.org/tx/${e.tx}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {e.tx.slice(0, 8)}...
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            No detections yet. Waiting for new pools...
          </div>
        )}
      </div>
    </Layout>
  );
}
