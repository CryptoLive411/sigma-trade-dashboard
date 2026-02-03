import useSWR from 'swr'
import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import Layout from '../components/Layout'
import toast from 'react-hot-toast'
import { XMarkIcon } from '@heroicons/react/24/outline'

const fetcher = (url) => api.get(url).then(r=>r.data)

export default function Trackers(){
  const { data, mutate } = useSWR('/api/trackers', fetcher, { refreshInterval: 3000 })
  const { data: metrics } = useSWR('/api/trackers/metrics', fetcher, { refreshInterval: 3000 })
  const [editing, setEditing] = useState(null) // tracker being edited (object)
  const [draft, setDraft] = useState(null)
  const [cloneOf, setCloneOf] = useState('')
  const [cloneName, setCloneName] = useState('')
  const [testTx, setTestTx] = useState('')
  const [testingTracker, setTestingTracker] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [logsFor, setLogsFor] = useState(null) // tracker object
  const [logs, setLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [pendingEnable, setPendingEnable] = useState(null) // tracker awaiting risk confirm
  const [forceBusy, setForceBusy] = useState(false)
  const [sellTxids, setSellTxids] = useState('')
  const [sellPct, setSellPct] = useState(100)
  const [sellBusy, setSellBusy] = useState(false)
  const [sellResults, setSellResults] = useState(null)

  // Bulk actions
  async function enableAll(){
    try {
      await Promise.all(list.filter(t=>!t.enabled).map(t=> api.post(`/api/trackers/${t.id}/enable`).catch(()=>null)))
      toast.success('All trackers enabled')
      mutate()
    } catch (e) {
      toast.error('Failed enabling all')
    }
  }
  const SAFE_PREFIX_BLOCKLIST = ['uniswapv2','uniswapv3','uniswapv4','baseswapv2','baseswapv3','aerodrome','contentcoin','zora']
  async function enableSafe(){
    try {
      await Promise.all(list.filter(t=>!t.enabled && !SAFE_PREFIX_BLOCKLIST.some(p=> (t.name||'').toLowerCase().startsWith(p))).map(t=> api.post(`/api/trackers/${t.id}/enable`).catch(()=>null)))
      toast.success('Safe trackers enabled')
      mutate()
    } catch (e) {
      toast.error('Failed enabling safe trackers')
    }
  }
  async function disableAll(){
    try {
      await Promise.all(list.filter(t=>t.enabled).map(t=> api.post(`/api/trackers/${t.id}/disable`).catch(()=>null)))
      toast.success('All trackers disabled')
      mutate()
    } catch (e) {
      toast.error('Failed disabling all')
    }
  }

  // Force clear open trades (global)
  async function forceClearAll(){
    try {
      setForceBusy(true)
      const r = await api.post('/api/trades/force-sell-open', {})
      const ok = r?.data?.ok
      if (ok) {
        const s = r.data.summary || {}
        const uw = r.data.unwrap || {}
        const uwMsg = uw.attempted ? (uw.ok ? ' + unwrapped WETH' : ' + unwrap failed') : ''
        toast.success(`Force-sell: ${s.succeeded||0}/${s.attempted||0} succeeded${uwMsg}`)
      } else {
        toast.error('Force-sell failed')
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Force-sell failed')
    } finally {
      setForceBusy(false)
    }
  }

  // Sell by txid(s)
  async function sellByTx(){
    try {
      setSellBusy(true)
      setSellResults(null)
      const body = { txids: sellTxids, amountPct: sellPct }
      const r = await api.post('/api/trades/sell-by-tx', body)
      const ok = r?.data?.ok
      if (ok) {
        const s = r.data.summary || {}
        const uw = r.data.unwrap || {}
        const uwMsg = uw.attempted ? (uw.ok ? ' + unwrapped WETH' : ' + unwrap failed') : ''
        toast.success(`Sell-by-tx: ${s.succeeded||0}/${s.attempted||0} succeeded${uwMsg}`)
        setSellResults(r.data)
      } else {
        toast.error('Sell-by-tx failed')
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Sell-by-tx failed')
    } finally {
      setSellBusy(false)
    }
  }

  // Force clear per-tracker
  async function forceClearTracker(trackerId){
    try {
      setForceBusy(true)
      const r = await api.post('/api/trades/force-sell-open', { trackerId })
      const ok = r?.data?.ok
      if (ok) {
        const s = r.data.summary || {}
        const uw = r.data.unwrap || {}
        const uwMsg = uw.attempted ? (uw.ok ? ' + unwrapped WETH' : ' + unwrap failed') : ''
        toast.success(`Force-sell (${trackerId}): ${s.succeeded||0}/${s.attempted||0} succeeded${uwMsg}`)
      } else {
        toast.error('Force-sell failed')
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Force-sell failed')
    } finally {
      setForceBusy(false)
    }
  }

  async function openLogs(tracker){
    setLogsFor(tracker)
    setLogs([])
    setLogsLoading(true)
    try {
      const r = await api.get('/api/trackerlog', { params: { trackerId: tracker.id, limit: 300 } })
      setLogs(r.data || [])
    } catch (e) {
      toast.error('Failed to load logs')
    } finally {
      setLogsLoading(false)
    }
  }

  const RISKY_DEX_NAMES = ['uniswapv2','uniswapv3','uniswapv4','baseswapv2','baseswapv3','aerodrome','contentcoin','zora']
  async function enable(id){
    const tracker = list.find(t=>t.id===id)
    const nameLc = (tracker?.name||'').toLowerCase()
    if(tracker && RISKY_DEX_NAMES.some(r=>nameLc.startsWith(r))){
      setPendingEnable(tracker)
      return
    }
    await api.post(`/api/trackers/${id}/enable`)
    toast.success('Tracker enabled')
    mutate()
  }

  async function confirmEnableRisky(){
    if(!pendingEnable) return
    const id = pendingEnable.id
    setPendingEnable(null)
    await api.post(`/api/trackers/${id}/enable`)
    toast.success('Tracker enabled')
    mutate()
  }
  async function disable(id){ await api.post(`/api/trackers/${id}/disable`); toast.success('Tracker disabled'); mutate() }
  async function saveConfig(){ if(!editing) return; await api.put(`/api/trackers/${editing.id}/config`, { trading: draft.trading, maxActiveBuyEth: draft.maxActiveBuyEth, maxTrades: draft.maxTrades, include: draft.include, blacklist: draft.blacklist, priority: draft.priority, enabled: draft.enabled, name: draft.name }); toast.success('Config saved'); setEditing(null); setDraft(null); mutate() }
  async function cloneTracker(){
    if(!cloneOf || !cloneName){ toast.error('Pick a tracker and name'); return }
    await api.post(`/api/trackers/${cloneOf}/clone`, { name: cloneName })
    toast.success('Cloned')
    setCloneOf('')
    setCloneName('')
    mutate()
  }

  const findMetrics = (id) => (metrics?.perTracker||[]).find(x=>x.id===id)?.metrics || { activeEthWei:'0', realizedPnLEthWei:'0', tradesCount: 0 }
  const toEth = (w) => {
    const n = Number(w||0)
    return isFinite(n) ? (n/1e18) : 0
  }
  const list = useMemo(()=> Array.isArray(data)? data: [], [data])
  if(!data) return <Layout title="Trackers"><div className="card">Loading...</div></Layout>

  return (
    <Layout title="Trackers">
      <div className="card">
        <div className="flex flex-wrap gap-2 mb-2">
          <button className="btn btn-outline" onClick={enableSafe}>Enable Safe</button>
          <button className="btn btn-outline" onClick={enableAll}>Enable All</button>
          <button className="btn btn-outline" onClick={disableAll}>Disable All</button>
          <button className="btn" disabled={forceBusy} onClick={forceClearAll}>{forceBusy? 'Clearing…':'Force Clear Open Trades'}</button>
        </div>
        <div className="row gap-2 mb-2">
          <input className="input flex-1" placeholder="Sell by txid(s): 0xaaa, 0xbbb or whitespace separated" value={sellTxids} onChange={(e)=>setSellTxids(e.target.value)} />
          <input className="input w-32" type="number" min="1" max="100" value={sellPct} onChange={(e)=>setSellPct(Number(e.target.value))} />
          <button className="btn" disabled={sellBusy || !sellTxids.trim()} onClick={sellByTx}>{sellBusy? 'Selling…':'Sell by Tx'}</button>
        </div>
        <div className="row gap-2">
          <input className="input flex-1" placeholder="Test tx hash (0x...)" value={testTx} onChange={(e)=>setTestTx(e.target.value)} />
          <select className="input" value={testingTracker} onChange={(e)=>setTestingTracker(e.target.value)}>
            <option value="">All trackers</option>
            {list.map(t=> <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn" onClick={async ()=>{ try{ const body = testingTracker? { tx: testTx, trackerId: testingTracker } : { tx: testTx }; const r = await api.post('/api/trackers/test', body); setTestResult(r.data) } catch(e){ toast.error(e?.response?.data?.error || 'Test failed') } }}>Run Test</button>
        </div>
        {sellResults && (
          <div className="mt-2 text-sm">
            <div className="muted">Sell-by-tx results:</div>
            <ul className="list-disc pl-6">
              {(sellResults.results||[]).map((r, idx)=> (
                <li key={idx}>
                  <span className="text-white font-medium">{r.tx}</span>: {r.ok? 'sold' : 'failed'}
                  {r.tracker && <span className="ml-2">tracker: <span className="text-slate-300">{r.tracker}</span></span>}
                  {r.token && <span className="ml-2">token: <span className="text-slate-300">{r.token}</span></span>}
                  {r.sellTx && <span className="ml-2">sellTx: <span className="text-slate-300">{r.sellTx}</span></span>}
                  {r.error && <span className="ml-2 text-rose-300">error: {r.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {testResult && (
          <div className="mt-2 text-sm">
            <div className="muted">Results for {testResult.tx}:</div>
            <ul className="list-disc pl-6">
        {(testResult.results||[]).map(r => (
                <li key={r.trackerId}>
          <span className="text-white font-medium">{r.name}</span>: detected={String(r.detected)}, processed={String(r.processed)} {r.reason? <span className="text-slate-400">({r.reason})</span>: null} {r.error? <span className="text-rose-400">({r.error})</span>: null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      
      
      <div className="card">
        {list.map(t => {
          const m = findMetrics(t.id)
          const status = t.enabled
          return (
            <div key={t.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-800 last:border-0 py-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="text-lg font-semibold">{t.name}</div>
                  <span className={status? 'pill bg-emerald-900/40 border-emerald-700 text-emerald-300':'pill bg-rose-900/40 border-rose-700 text-rose-300'}>{status? 'Enabled':'Disabled'}</span>
                  <span className="pill">Priority: {t.priority}</span>
                  <span className="pill">Max Trades: {t.maxTrades ?? 0}</span>
                </div>
                <div className="muted text-sm">Active: {toEth(m.activeEthWei).toFixed(6)} ETH | Realized: {toEth(m.realizedPnLEthWei).toFixed(6)} ETH | Trades: {m.tradesCount ?? 0}</div>
              </div>
              <div className="flex items-center gap-2">
                <button className="btn btn-outline" onClick={()=>{ setEditing(t); setDraft(JSON.parse(JSON.stringify(t))) }}>Edit Config</button>
                <button className="btn btn-outline" onClick={()=>openLogs(t)}>View Logs</button>
                <button className="btn btn-outline" disabled={forceBusy} onClick={()=>forceClearTracker(t.id)}>Force Clear</button>
                {status? (
                  <button className="btn" onClick={()=>disable(t.id)}>Disable</button>
                ): (
                  <button className="btn" onClick={()=>enable(t.id)}>Enable</button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={()=>{ setEditing(null); setDraft(null) }} />
          <div className="relative w-full max-w-2xl card">
            <div className="flex items-center justify-between">
              <h3 className="m-0 text-lg font-semibold">Edit Config — {editing.name}</h3>
              <button className="btn btn-outline" onClick={()=>{ setEditing(null); setDraft(null) }}><XMarkIcon className="w-4 h-4"/></button>
            </div>
            <div className="grid mt-3">
              <div>
                <div className="muted">Priority</div>
                <input className="input" type="number" value={draft.priority} onChange={(e)=>setDraft({...draft, priority: Number(e.target.value)})} />
              </div>
              <div>
                <div className="muted">Max Active Buy (ETH)</div>
                <input className="input" value={draft.maxActiveBuyEth || '0'} onChange={(e)=>setDraft({...draft, maxActiveBuyEth: e.target.value})} />
              </div>
              <div>
                <div className="muted">Max Trades (0 = unlimited)</div>
                <input className="input" type="number" min="0" value={draft.maxTrades ?? 0} onChange={(e)=>setDraft({...draft, maxTrades: Number(e.target.value)})} />
              </div>
            </div>
            <div className="grid mt-3">
              <div>
                <div className="muted">Include (comma-separated)</div>
                <input className="input" value={(draft.include||[]).join(',')} onChange={(e)=>setDraft({...draft, include: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} />
              </div>
              <div>
                <div className="muted">Blacklist (comma-separated)</div>
                <input className="input" value={(draft.blacklist||[]).join(',')} onChange={(e)=>setDraft({...draft, blacklist: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} />
              </div>
            </div>
            <div className="grid mt-3">
              <div>
                <div className="muted">Trading.buyEthAmount</div>
                <input className="input" value={draft.trading?.buyEthAmount || ''} onChange={(e)=>setDraft({...draft, trading: { ...(draft.trading||{}), buyEthAmount: e.target.value }})} />
              </div>
              <div>
                <div className="muted">Trading.sellProfitPct</div>
                <input className="input" type="number" step="0.1" value={draft.trading?.sellProfitPct ?? ''} onChange={(e)=>setDraft({...draft, trading: { ...(draft.trading||{}), sellProfitPct: Number(e.target.value) }})} />
              </div>
              <div>
                <div className="muted">Trading.sellLossPct</div>
                <input className="input" type="number" step="0.1" value={draft.trading?.sellLossPct ?? ''} onChange={(e)=>setDraft({...draft, trading: { ...(draft.trading||{}), sellLossPct: Number(e.target.value) }})} />
              </div>
              <div>
                <div className="muted">Trading.sellMaxHoldSeconds</div>
                <input className="input" type="number" value={draft.trading?.sellMaxHoldSeconds ?? ''} onChange={(e)=>setDraft({...draft, trading: { ...(draft.trading||{}), sellMaxHoldSeconds: Number(e.target.value) }})} />
              </div>
              <div>
                <div className="muted">Trading.minWethLiquidity</div>
                <input className="input" value={draft.trading?.minWethLiquidity || ''} onChange={(e)=>setDraft({...draft, trading: { ...(draft.trading||{}), minWethLiquidity: e.target.value }})} />
              </div>
              <div className="flex items-center gap-2">
                <input id="hp" type="checkbox" checked={!!draft.trading?.disableHoneypotCheck} onChange={(e)=>setDraft({ ...draft, trading: { ...(draft.trading||{}), disableHoneypotCheck: e.target.checked }})} />
                <label htmlFor="hp" className="muted">Disable Honeypot Check</label>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button className="btn btn-outline" onClick={()=>{ setEditing(null); setDraft(null) }}>Cancel</button>
              <button className="btn" onClick={saveConfig}>Save Config</button>
            </div>
          </div>
        </div>
      )}

      {logsFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={()=>{ setLogsFor(null); setLogs([]) }} />
          <div className="relative w-full max-w-3xl card max-h-[80vh] overflow-hidden">
            <div className="flex items-center justify-between">
              <h3 className="m-0 text-lg font-semibold">Logs — {logsFor.name}</h3>
              <div className="flex items-center gap-2">
                <button className="btn btn-outline" onClick={()=>openLogs(logsFor)}>Refresh</button>
                <button className="btn btn-outline" onClick={()=>{ setLogsFor(null); setLogs([]) }}><XMarkIcon className="w-4 h-4"/></button>
              </div>
            </div>
            <div className="mt-3 bg-black/40 rounded border border-slate-800 p-2 overflow-auto max-h-[65vh] text-xs">
              {logsLoading && <div className="muted">Loading...</div>}
              {!logsLoading && logs.length === 0 && <div className="muted">No logs</div>}
              {!logsLoading && logs.length > 0 && (
                <ul className="space-y-2">
                  {logs.slice().reverse().map((e, idx) => (
                    <li key={idx} className="border-b border-slate-800 pb-2 last:border-0">
                      <div className="text-slate-300">
                        <span className="text-slate-400">{new Date(e.time).toLocaleTimeString()}</span>
                        <span className="ml-2 pill">{e.phase}</span>
                        {e.tx && <span className="ml-2">tx: <span className="text-white">{e.tx}</span></span>}
                        {e.tokenOut && <span className="ml-2">token: <span className="text-white">{e.tokenOut}</span></span>}
                        {e.token && !e.tokenOut && <span className="ml-2">token: <span className="text-white">{e.token}</span></span>}
                        {e.pool && <span className="ml-2">pool: <span className="text-white">{e.pool}</span></span>}
                        {e.pair && <span className="ml-2">pair: <span className="text-white">{e.pair}</span></span>}
                        {e.reason && <span className="ml-2 text-rose-300">reason: {e.reason}</span>}
                      </div>
                      <pre className="mt-1 whitespace-pre-wrap break-words text-slate-400">{JSON.stringify(e, null, 2)}</pre>
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
          <div className="absolute inset-0 bg-black/70" onClick={()=>setPendingEnable(null)} />
          <div className="relative w-full max-w-md card">
            <h3 className="m-0 text-lg font-semibold">High Risk DEX</h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-300">
              <span className="font-semibold text-white">{pendingEnable.name}</span> is considered a <span className="text-rose-300 font-medium">HIGH RISK</span> venue to trade on.
              New listings can be illiquid, manipulated, or outright scams. Proceed only with very small test amounts and monitor behavior closely.
            </p>
            <ul className="mt-2 text-xs list-disc pl-5 text-slate-400 space-y-1">
              <li>Liquidity may be pulled instantly (rug risk)</li>
              <li>Tokens may have transfer taxes / honeypot behavior</li>
              <li>Slippage & MEV can cause large losses</li>
            </ul>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="btn btn-outline" onClick={()=>setPendingEnable(null)}>Cancel</button>
              <button className="btn" onClick={confirmEnableRisky}>I Understand, Enable</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
