import { useEffect, useMemo, useState, useCallback } from 'react'
import Layout from '../components/Layout'
import { getSocket } from '../lib/socket'
import { api } from '../lib/api'

// External link icon for BaseScan links
const ExternalLinkIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="inline" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" style={{marginBottom: '-2px'}}>
    <path d="M13.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1-1.414 1.414L15 5.414V13a1 1 0 1 1-2 0V5.414l-1.293 1.293A1 1 0 0 1 10.293 5.293l3-3z"/>
    <path d="M5 7a2 2 0 0 1 2-2h3a1 1 0 1 1 0 2H7v8h6v-3a1 1 0 1 1 2 0v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7z"/>
  </svg>
);

export default function Trades(){
  const [rows, setRows] = useState([])
  const [history, setHistory] = useState([])
  const [detail, setDetail] = useState(null)
  const [tradeModal, setTradeModal] = useState(null) // { trackerId, token }
  const [stopModal, setStopModal] = useState(null) // { trackerId, token }
  const [loadingHist, setLoadingHist] = useState(true)
  const [hasLoadedHist, setHasLoadedHist] = useState(false)
  const [refreshingHist, setRefreshingHist] = useState(false)
  const [query, setQuery] = useState('')
  const [filterDex, setFilterDex] = useState('') // empty = all
  const [filterTrackerName, setFilterTrackerName] = useState('') // both tokens and trades (name)
  const [trackers, setTrackers] = useState([])
  const [defaultMaxHoldMs, setDefaultMaxHoldMs] = useState(3600 * 1000)

  // Known DEX names as a fallback to ensure options show even before data flows in
  const KNOWN_DEXES = useMemo(()=>[
    'UniswapV2','UniswapV3','UniswapV4','BaseSwapV2','BaseSwapV3','Aerodrome','ClankerV4','ZoraV4','ContentCoinV4','KingOfApes','ApeStore'
  ], [])

  // Helpers to maintain the live tokens list
  const ensureTokenRow = useCallback((token, extra = {}) => {
    if (!token) return
    setRows((arr) => {
      const id = token.toLowerCase()
      const idx = arr.findIndex(x => x.id === id)
      const patch = Object.fromEntries(Object.entries({
        token,
        dex: extra.dex,
        trackerId: extra.trackerId,
        trackerName: extra.trackerName,
        pool: extra.pool,
        manual: extra.manual,
        pnlPct: extra.pnlPct,
        quotedEthOut: extra.quotedEthOut,
        timeLeftMs: extra.timeLeftMs,
        startedAt: extra.startedAt,
        maxHoldMs: extra.maxHoldMs,
      }).filter(([,v]) => v !== undefined))
      if (idx >= 0) {
        const next = arr.slice()
        next[idx] = { ...next[idx], ...patch, last: Date.now() }
        return next
      }
      const entry = {
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
      }
      return [entry, ...arr].slice(0, 100)
    })
  }, [])

  const removeTokenRow = useCallback((token) => {
    if (!token) return
    setRows((arr) => arr.filter(x => x.id !== token.toLowerCase()))
  }, [])

  // Unified loader for recent trades
  const loadTrades = useCallback(async () => {
    let initial = !hasLoadedHist
    if (initial) setLoadingHist(true); else setRefreshingHist(true)
    try {
      const { data } = await api.get('/api/trades?page=0&pageSize=50')
      const items = data.items || []
      setHistory(items)
      // Seed live token rows from open trades to avoid missing tokens after refresh
      // We only add/patch rows here (no removals) to avoid dropping tokens that may be open but older than the first page
      items.forEach(t => {
        if (t && t.status === 'open' && t.token) {
          ensureTokenRow(t.token, {
            dex: t.dex,
            trackerId: t.trackerId,
            trackerName: t.trackerName,
            pool: t.pool,
            startedAt: t.startedAt,
          })
        }
      })
      if (initial) setHasLoadedHist(true)
    } catch (_) {
      // ignore
    } finally {
      if (initial) setLoadingHist(false); else setRefreshingHist(false)
    }
  }, [hasLoadedHist, ensureTokenRow])
  useEffect(()=>{
    loadTrades()
  }, [loadTrades])
  useEffect(()=>{
    let mounted = true
    // Also refresh on socket buy/sell/manual events and every 15s as a fallback
    const s = getSocket()
    const toToken = (evt) => {
      if (!evt) return null
      return evt.token || evt.tokenOut || evt.tokenIn || null
    }
    const schedule = (() => {
      let last = 0
      return () => {
        const now = Date.now()
        if (now - last < 2000) return // throttle
        last = now
        loadTrades()
      }
    })()
    const onBuy = (evt) => {
      const tok = toToken(evt)
      if (tok) ensureTokenRow(tok, { dex: evt?.dex, trackerId: evt?.trackerId, trackerName: evt?.trackerName, pool: evt?.pool || evt?.pair })
      schedule()
    }
    const onSell = (evt) => {
      const tok = toToken(evt)
      if (tok) removeTokenRow(tok)
      schedule()
    }
    const onManual = (evt) => {
      if (!evt) return
      const tok = toToken(evt)
      if (evt.type === 'buy' && tok) ensureTokenRow(tok, { trackerId: evt.trackerId, trackerName: evt.trackerName, manual: true, dex: evt.dex, pool: evt?.pool || evt?.pair })
      if (evt.type === 'sell' && tok) {
        const pct = Number(evt.amountPct)
        if (!Number.isFinite(pct) || pct >= 99) removeTokenRow(tok)
      }
      if (evt.type === 'config' && tok && evt.config) {
        const key = `${(evt.trackerId || '')}:${tok.toLowerCase()}`
        setManualCfg((cfg) => ({ ...cfg, [key]: evt.config }))
      }
      schedule()
    }
    s.on('trade:buy', onBuy)
    s.on('trade:sell', onSell)
    s.on('manual:action', onManual)
    const iv = setInterval(loadTrades, 15000)
    return ()=>{ mounted = false; s.off('trade:buy', onBuy); s.off('trade:sell', onSell); s.off('manual:action', onManual); clearInterval(iv) }
  }, [loadTrades, ensureTokenRow, removeTokenRow])

  // Load all trackers for full tracker options list
  useEffect(()=>{
    let mounted = true
    ;(async()=>{
      try {
        const { data } = await api.get('/api/trackers')
        if (mounted && Array.isArray(data)) setTrackers(data)
      } catch(_){}
    })()
    return ()=>{ mounted = false }
  },[])

  // Load runtime once to pick up configured max hold seconds (fallbacks for timeLeft)
  useEffect(()=>{
    let mounted = true
    ;(async()=>{
      try {
        const { data } = await api.get('/api/runtime')
        const secs = Number(data?.trading?.sellMaxHoldSeconds)
        if (mounted && Number.isFinite(secs) && secs > 0) setDefaultMaxHoldMs(secs * 1000)
      } catch(_){}
    })()
    return ()=>{ mounted = false }
  }, [])

  useEffect(()=>{
    const s = getSocket()
    const onMon = (m) => {
      const tok = m.token || m.tokenOut || m.tokenIn
      if (!tok) return
      setRows((arr)=>{
        const id = tok.toLowerCase()
        const next = arr.slice()
        const idx = next.findIndex(x=>x.id===id)
        const recPatchRaw = {
          id,
          token: tok,
          pnlPct: (typeof m.pnlPct === 'number') ? m.pnlPct : (typeof m.pnl === 'number' ? m.pnl : undefined),
          // Some trackers (e.g. V2) emit outEth instead of quotedEthOut; map it to wei for consistency
          quotedEthOut: (m.quotedEthOut != null) ? m.quotedEthOut : (m.outEth != null ? String(Math.floor(Number(m.outEth) * 1e18)) : undefined),
          timeLeftMs: m.timeLeftMs,
          startedAt: m.startedAt,
          maxHoldMs: m.maxHoldMs,
          dex: m.dex,
          trackerId: m.trackerId,
          trackerName: m.trackerName,
          pool: m.pool || m.pair,
          last: Date.now(),
        }
        const rec = Object.fromEntries(Object.entries(recPatchRaw).filter(([,v]) => v !== undefined))
        if (idx>=0) next[idx] = { ...next[idx], ...rec }
        else next.unshift(rec)
        return next.slice(0,100)
      })
    }
    s.on('trade:monitor', onMon)
    return ()=>{ s.off('trade:monitor', onMon) }
  },[])

  // Periodically backfill timeLeftMs for rows missing monitor-provided timers using startedAt and default max hold
  useEffect(()=>{
    const iv = setInterval(()=>{
      setRows((arr)=>{
        let changed = false
        const now = Date.now()
        const out = arr.map(r => {
          if (!r) return r
          // If monitor already provides a timer, keep it; otherwise compute from startedAt
          if (r.startedAt && (r.timeLeftMs == null || r.maxHoldMs == null)) {
            const max = r.maxHoldMs != null ? r.maxHoldMs : defaultMaxHoldMs
            const tl = Math.max(0, max - (now - r.startedAt))
            changed = true
            return { ...r, timeLeftMs: tl, maxHoldMs: r.maxHoldMs != null ? r.maxHoldMs : max }
          }
          return r
        })
        return changed ? out : arr
      })
    }, 5000)
    return ()=> clearInterval(iv)
  }, [defaultMaxHoldMs])

  const fmtPct = (p)=> p==null? '—' : (p*100).toFixed(2)+'%'
  const fmtTime = (ms)=> ms==null? '—' : `${Math.floor(ms/1000)}s`
  const [meta, setMeta] = useState({})
  const [manualCfg, setManualCfg] = useState({}) // key: trackerId:token -> {enabled, stopLossPct}
  const keyMT = (trackerId, token) => `${(trackerId||'')}:${(token||'').toLowerCase()}`
  const loadManual = useCallback(async (trackerId, token) => {
    try {
      const { data } = await api.get('/api/trades/manual', { params: { trackerId, token } })
      setManualCfg((m)=> ({ ...m, [keyMT(trackerId, token)]: data.config || { enabled: false } }))
    } catch (_) {}
  }, [])
  const ensureMeta = useCallback(async (addr) => {
    if (!addr) return null
    const key = addr.toLowerCase()
    if (meta[key]) return meta[key]
    try {
      const { data } = await api.get(`/api/tokens/${addr}`)
      setMeta((m)=> ({ ...m, [key]: data }))
      return data
    } catch (_) { return null }
  }, [meta])

  // Prefetch some token meta when searching by name to improve matching
  useEffect(()=>{
    const q = (query||'').trim().toLowerCase()
    if (q.length < 2) return
    const addrs = new Set()
    rows.forEach(r=>{ if (r.token) addrs.add(r.token.toLowerCase()) })
    history.forEach(t=>{ if (t.token) addrs.add((t.token||'').toLowerCase()) })
    const toFetch = Array.from(addrs).slice(0, 30)
    toFetch.forEach(a=>{ if (!meta[a]) ensureMeta(a) })
  }, [query, rows, history])

  // Derived filters and sorted views
  const dexOptions = useMemo(()=>{
    const s = new Set(KNOWN_DEXES)
    rows.forEach(r=>{ if (r.dex) s.add(r.dex) })
    history.forEach(t=>{ if (t.dex) s.add(t.dex) })
    return Array.from(s).sort((a,b)=> a.localeCompare(b))
  }, [rows, history, KNOWN_DEXES])

  const trackerOptions = useMemo(()=>{
    // prefer API list, but also merge any seen in rows/history
    const set = new Set()
    const list = Array.isArray(trackers) ? trackers : []
    list.forEach(t=>{ if (t?.name) set.add(t.name) })
    rows.forEach(r=>{ if (r?.trackerName) set.add(r.trackerName) })
    history.forEach(h=>{ if (h?.trackerName) set.add(h.trackerName) })
    return Array.from(set).sort((a,b)=> a.localeCompare(b))
  }, [trackers, rows, history])

  const matchesQuery = (address, extraText='') => {
    const q = (query||'').trim().toLowerCase()
    if (!q) return true
    const addr = (address||'').toLowerCase()
    if (addr.includes(q)) return true
    const m = meta[addr]
    if (m && ((m.symbol||'').toLowerCase().includes(q) || (m.name||'').toLowerCase().includes(q))) return true
    if ((extraText||'').toLowerCase().includes(q)) return true
    return false
  }

  const viewRows = useMemo(()=>{
    const filtered = rows.filter(r => {
      if (filterDex && (r.dex||'') !== filterDex) return false
      if (filterTrackerName && (r.trackerName||'') !== filterTrackerName) return false
      return matchesQuery(r.token)
    })
    // sort by pnlPct desc (nulls last)
    filtered.sort((a,b)=>{
      const pa = (typeof a.pnlPct === 'number') ? a.pnlPct : -Infinity
      const pb = (typeof b.pnlPct === 'number') ? b.pnlPct : -Infinity
      return pb - pa
    })
    return filtered
  }, [rows, filterDex, filterTrackerName, query, meta])

  const viewHistory = useMemo(()=>{
    return history.filter(t => {
      if (filterDex && (t.dex||'') !== filterDex) return false
      if (filterTrackerName && (t.trackerName||'') !== filterTrackerName) return false
      return matchesQuery(t.token, `${t.trackerName||''} ${t.dex||''}`)
    })
  }, [history, filterDex, filterTrackerName, query, meta])

  return (
    <Layout title="Live Trades">
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-end gap-2 mb-3">
          <div className="flex-1">
            <div className="muted text-xs mb-1">Search token (address / name / symbol)</div>
            <input className="input w-full" placeholder="0x... or PEPE" value={query} onChange={(e)=>setQuery(e.target.value)} />
          </div>
          <div>
            <div className="muted text-xs mb-1">DEX</div>
            <select className="input" value={filterDex} onChange={(e)=>setFilterDex(e.target.value)}>
              <option value="">All DEXes</option>
              {dexOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <div className="muted text-xs mb-1">Tracker</div>
            <select className="input" value={filterTrackerName} onChange={(e)=>setFilterTrackerName(e.target.value)}>
              <option value="">All trackers</option>
              {trackerOptions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto">
          <table className="table">
            <thead><tr><th>Token</th><th>PnL</th><th>Quoted ETH Out</th><th>Time Left</th><th>Started</th><th>Manual</th><th>Actions</th></tr></thead>
            <tbody>
              {viewRows.map(r=> (
                <tr key={r.id}>
                  <td>
                    <TokenCell
                      address={r.token}
                      trackerName={r.trackerName}
                      dex={r.dex}
                      pool={r.pool}
                      meta={meta}
                      ensureMeta={ensureMeta}
                    />
                  </td>
                  <td className={r.pnlPct>0? 'text-emerald-400': r.pnlPct<0? 'text-rose-400':'inherit'}>{fmtPct(r.pnlPct)}</td>
                  <td>{r.quotedEthOut? Number(r.quotedEthOut)/1e18 : '—'}</td>
                  <td>{fmtTime(r.timeLeftMs)}</td>
                  <td>{r.startedAt? new Date(r.startedAt).toLocaleTimeString(): '—'}</td>
                  <td>
                    <ManualToggle
                      trackerId={r.trackerId}
                      token={r.token}
                      cfg={manualCfg[keyMT(r.trackerId,r.token)]}
                      onLoad={()=>loadManual(r.trackerId, r.token)}
                      onChange={(c)=> setManualCfg((m)=>({ ...m, [keyMT(r.trackerId, r.token)]: c }))}
                      onOpenStop={()=> setStopModal({ trackerId: r.trackerId, token: r.token })}
                    />
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button className="btn btn-xs" onClick={()=> setTradeModal({ trackerId: r.trackerId, token: r.token })}>Trade</button>
                      <button className="btn btn-xs" onClick={()=> setStopModal({ trackerId: r.trackerId, token: r.token })}>Stop Loss</button>
                    </div>
                  </td>
                </tr>
              ))}
              {viewRows.length===0 && (
                [...Array(3)].map((_,i)=> (
                  <tr key={`sk-${i}`}>
                    <td colSpan={5}>
                      <div className="animate-pulse h-4 bg-slate-800/80 rounded" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card mt-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold">Recent Trades</h3>
            {hasLoadedHist && refreshingHist && (
              <span className="inline-flex items-center gap-1 text-xs muted">
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                </svg>
                Updating…
              </span>
            )}
          </div>
          <button className="btn inline-flex items-center gap-2" disabled={refreshingHist && hasLoadedHist} onClick={loadTrades}>
            {refreshingHist && hasLoadedHist && (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
              </svg>
            )}
            Refresh
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Token</th>
                <th>DEX</th>
                <th>Tracker</th>
                <th>Creator</th>
                <th>Status</th>
                <th>Buy Tx</th>
                <th>Sell Tx</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!hasLoadedHist && loadingHist ? (
                [...Array(5)].map((_,i)=> (
                  <tr key={`hsk-${i}`}>
                    <td colSpan={9}><div className="animate-pulse h-4 bg-slate-800/80 rounded" /></td>
                  </tr>
                ))
              ) : (
                <>
                {viewHistory.map(t => (
                <tr key={t.id}>
                  <td>{t.startedAt ? new Date(t.startedAt).toLocaleString() : '—'}</td>
                  <td>
                    {t.token ? (
                      <TokenCell
                        address={t.token}
                        trackerName={null}
                        dex={t.dex}
                        pool={t.pool}
                        meta={meta}
                        ensureMeta={ensureMeta}
                      />
                    ) : '—'}
                  </td>
                  <td>{t.dex}</td>
                  <td title={t.trackerId}>{t.trackerName}</td>
                  <td>
                    {t.creator ? (
                      <div>
                        <a 
                          className="link font-mono text-xs" 
                          href={`https://basescan.org/address/${t.creator}`} 
                          target="_blank" 
                          rel="noreferrer"
                          title={t.creator}
                        >
                          {t.creator.slice(0,6)}...{t.creator.slice(-4)}
                        </a>
                        {typeof t.creatorTokens !== 'undefined' && (
                          <div className="text-xs text-muted mt-1" title="Total tokens created by this address">
                            {t.creatorTokens} total
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                  <td>{t.status}</td>
                  <td>{t.buyTx ? <a className="link" href={`https://basescan.org/tx/${t.buyTx}`} target="_blank" rel="noreferrer">view</a> : '—'}</td>
                  <td>{t.sellTx ? <a className="link" href={`https://basescan.org/tx/${t.sellTx}`} target="_blank" rel="noreferrer">view</a> : '—'}</td>
                  <td><button className="btn" onClick={async()=>{ try { const {data}=await api.get(`/api/trades/${t.id}`); setDetail(data) } catch(_){}}}>Info</button></td>
                </tr>
                ))}
                {viewHistory.length===0 && (
                  <tr><td colSpan={9} className="muted">No trades</td></tr>
                )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="modal" onClick={()=>setDetail(null)}>
          <div className="modal-box" onClick={e=>e.stopPropagation()}>
            <h3 className="font-bold text-lg">Trade Info</h3>
            <p className="mt-2 text-sm">ID: <span className="mono">{detail.id}</span></p>
            <p className="mt-1 text-sm">Tracker: {detail.trackerName} <span className="mono text-xs">({detail.trackerId})</span></p>
            <p className="mt-1 text-sm">DEX: {detail.dex}</p>
            <p className="mt-1 text-sm">Token: <TokenCell address={detail.token} trackerName={detail.trackerName} dex={detail.dex} pool={detail.pool} meta={meta} ensureMeta={ensureMeta} showLinks={false} /></p>
            <p className="mt-1 text-sm">Started: {detail.startedAt ? new Date(detail.startedAt).toLocaleString() : '—'}</p>
            <p className="mt-1 text-sm">Finished: {detail.finishedAt ? new Date(detail.finishedAt).toLocaleString() : '—'}</p>
            <div className="mt-3">
              <h4 className="font-semibold">Transactions</h4>
              <ul className="list-disc pl-6 text-sm max-h-64 overflow-auto">
                {(detail.txs || []).map((x, i) => (
                  <li key={i}>
                    <span className="mono">{new Date(x.time).toLocaleString()}</span>
                    {' '}[{x.action || 'tx'}:{x.phase}] {x.hash ? <a className="link" href={`https://basescan.org/tx/${x.hash}`} target="_blank" rel="noreferrer">{x.hash.slice(0,10)}…</a> : ''}
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-action">
              <button className="btn" onClick={()=>setDetail(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {tradeModal && (
        <TradeModal
          trackerId={tradeModal.trackerId}
          token={tradeModal.token}
          onClose={()=> setTradeModal(null)}
          onAfter={()=> { setTradeModal(null); loadTrades() }}
        />
      )}

      {stopModal && (
        <StopLossModal
          trackerId={stopModal.trackerId}
          token={stopModal.token}
          initial={manualCfg[keyMT(stopModal.trackerId, stopModal.token)]}
          onSaved={(cfg)=> { setStopModal(null); setManualCfg((m)=> ({ ...m, [keyMT(stopModal.trackerId, stopModal.token)]: cfg })) }}
          onClose={()=> setStopModal(null)}
        />
      )}
    </Layout>
  )
}

function TokenCell({ address, trackerName, meta, ensureMeta, dex, pool, showLinks = true }) {
  const [loading, setLoading] = useState(false)
  const key = (address||'').toLowerCase()
  const m = meta[key]
  useEffect(()=>{
    if (address && !m && !loading) {
      setLoading(true)
      Promise.resolve(ensureMeta(address)).finally(()=>setLoading(false))
    }
  }, [address, m, loading, ensureMeta])

  if (!address) return <span>—</span>

  const short = address.slice(0,10)+'…'
  const dexscreenerUrl = address ? `https://dexscreener.com/base/${address}` : null
  const uniswapUrl = pool ? `https://app.uniswap.org/explore/pools/base/${pool}` : (address ? `https://app.uniswap.org/explore/tokens/base/${address}` : null)
  const uniswapLabel = (dex || '').toLowerCase().includes('baseswap') ? 'BaseSwap' : 'Uniswap'

  const baseLink = m ? (
    <a className="link inline-flex items-center gap-1" href={`https://basescan.org/token/${address}`} target="_blank" rel="noreferrer">
      <span className="inline-block max-w-[160px] truncate align-middle" title={m.symbol}>{m.symbol}</span>
      <span className="muted mono">{short}</span>
      <ExternalLinkIcon />
    </a>
  ) : (
    <a className="link inline-flex items-center gap-1" href={`https://basescan.org/token/${address}`} target="_blank" rel="noreferrer">
      {short}
      <ExternalLinkIcon />
    </a>
  )

  const title = m ? `${m.name || m.symbol || ''} (${m.symbol || ''}) — ${address}`.trim() : address

  return (
    <div className="inline-flex flex-col gap-1" title={title}>
      <span className="inline-flex items-center gap-2">
        {baseLink}
        {trackerName ? (
          <span
            className="muted inline-block max-w-[180px] truncate align-middle"
            title={trackerName}
          >
            {trackerName}
          </span>
        ) : null}
      </span>
      {m && m.name && (
        <span className="muted text-xs inline-block max-w-[220px] truncate" title={m.name}>{m.name}</span>
      )}
      {showLinks && (
        <div className="flex flex-col gap-1 text-xs">
          {dexscreenerUrl && (
            <a className="link inline-flex items-center gap-1" href={dexscreenerUrl} target="_blank" rel="noreferrer">📊 DexScreener</a>
          )}
          {uniswapUrl && (
            <a className="link inline-flex items-center gap-1" href={uniswapUrl} target="_blank" rel="noreferrer">🦄 {uniswapLabel}</a>
          )}
        </div>
      )}
    </div>
  )
}

function ManualToggle({ trackerId, token, cfg, onLoad, onChange, onOpenStop }) {
  const [enabled, setEnabled] = useState(cfg?.enabled || false)
  const [saving, setSaving] = useState(false)
  useEffect(()=>{ onLoad && onLoad() }, [])
  useEffect(()=>{ setEnabled(cfg?.enabled||false) }, [cfg?.enabled])
  const persist = async (next) => {
    setSaving(true)
    try {
      const { data } = await api.post('/api/trades/manual', { trackerId, token, enabled: next, stopLossPct: cfg?.stopLossPct })
      onChange && onChange(data.config)
    } catch (_) { /* ignore */ }
    setSaving(false)
  }
  return (
    <div className="flex items-center gap-2">
      <label className="inline-flex items-center gap-1 text-xs" title="Enable manual mode (stop loss via popup)">
        <input type="checkbox" checked={enabled} disabled={saving} onChange={(e)=>{ const v=e.target.checked; setEnabled(v); persist(v) }} /> Manual
      </label>
    </div>
  )
}

function TradeModal({ trackerId, token, onClose, onAfter }) {
  const [amt, setAmt] = useState('0.01')
  const [pct, setPct] = useState('1')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { type, tx }
  const doBuy = async () => {
    setBusy(true)
    setResult(null)
    try {
      const { data } = await api.post('/api/trades/manual/buy', { trackerId, token, amountEth: Number(amt) })
      setResult({ type: 'buy', tx: data?.tx || null })
    } catch (e) { setResult({ type: 'buy', error: e?.response?.data?.error || 'failed' }) }
    setBusy(false)
  }
  const doSell = async () => {
    setBusy(true)
    setResult(null)
    try {
      // amountPct should be 0-100 (whole-number percent). Clamp accordingly.
      const pctNum = Number(pct)
      const pctClamped = Math.max(0, Math.min(100, Number.isFinite(pctNum) ? pctNum : 0))
      const { data } = await api.post('/api/trades/manual/sell', { trackerId, token, amountPct: pctClamped })
      setResult({ type: 'sell', tx: data?.tx || null })
    } catch (e) { setResult({ type: 'sell', error: e?.response?.data?.error || 'failed' }) }
    setBusy(false)
  }
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-box" onClick={e=>e.stopPropagation()}>
        <h3 className="font-bold text-lg">Manual Trade</h3>
        <p className="mono text-xs mt-1">Token: {(token||'').slice(0,10)}…</p>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="w-28 text-sm">Buy amount (ETH)</label>
            <input className="input w-40" value={amt} onChange={(e)=>setAmt(e.target.value)} />
            <button className="btn" disabled={busy} onClick={doBuy}>Buy</button>
          </div>
          <div className="flex items-center gap-2">
            <label className="w-28 text-sm">Sell percent (0-100)</label>
            <input className="input w-40" value={pct} onChange={(e)=>setPct(e.target.value)} />
            <button className="btn" disabled={busy} onClick={doSell}>Sell</button>
          </div>
          {busy && <div className="muted text-sm">Submitting…</div>}
          {result && (
            <div className="text-sm">
              {result.error ? (
                <div className="text-rose-400">{result.type.toUpperCase()} failed: {result.error}</div>
              ) : (
                <div className="text-emerald-400">{result.type.toUpperCase()} submitted {result.tx ? (<>
                  — <a className="link" href={`https://basescan.org/tx/${result.tx}`} target="_blank" rel="noreferrer">{result.tx.slice(0,10)}…</a>
                </>) : null}</div>
              )}
            </div>
          )}
        </div>
        <div className="modal-action">
          <button className="btn" onClick={()=> { onAfter && onAfter() }}>Close</button>
        </div>
      </div>
    </div>
  )
}

function StopLossModal({ trackerId, token, initial, onSaved, onClose }) {
  const [enabled, setEnabled] = useState(!!initial?.enabled)
  const [stop, setStop] = useState(initial?.stopLossPct ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(()=>{ if (!initial) { /* lazy fetch if not provided */ (async()=>{ try { const { data } = await api.get('/api/trades/manual', { params: { trackerId, token } }); setEnabled(!!data?.config?.enabled); setStop(data?.config?.stopLossPct ?? '') } catch(_){} })() } },[])
  const save = async () => {
    setSaving(true)
    try {
      const payload = { trackerId, token, enabled, stopLossPct: stop!==''? Number(stop): undefined }
      const { data } = await api.post('/api/trades/manual', payload)
      onSaved && onSaved(data.config)
    } catch (_) {}
    setSaving(false)
  }
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-box" onClick={(e)=>e.stopPropagation()}>
        <h3 className="font-bold text-lg">Manual & Stop Loss</h3>
        <p className="mono text-xs mt-1">Token: {(token||'').slice(0,10)}…</p>
        <div className="mt-3 flex flex-col gap-3">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e)=>setEnabled(e.target.checked)} />
            <span className="text-sm">Enable manual mode</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="w-28 text-sm">Stop loss %</label>
            <input className="input w-32" placeholder="e.g. 5" value={stop} onChange={(e)=>setStop(e.target.value)} />
            <span className="muted text-xs">Only applied when manual is enabled</span>
          </div>
        </div>
        <div className="modal-action">
          <button className="btn" disabled={saving} onClick={save}>Save</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
