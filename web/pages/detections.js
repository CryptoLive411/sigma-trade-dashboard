import { useEffect, useMemo, useRef, useState } from 'react'
import Layout from '../components/Layout'
import { getSocket } from '../lib/socket'
import { api } from '../lib/api'

export default function Detections(){
  const [items, setItems] = useState([])
  const [statusFilter, setStatusFilter] = useState('all') // 'all', 'pass', 'fail'
  const [tokenFilter, setTokenFilter] = useState('withTokens') // 'all', 'withTokens' - default to 'withTokens'
  const [isPaused, setIsPaused] = useState(false)
  const listRef = useRef(null)

  useEffect(()=>{
    // Preload latest detections
    ;(async()=>{
      try {
        const { data } = await api.get('/api/detections?limit=100')
        if (Array.isArray(data?.items)) setItems(data.items)
      } catch (_) {}
    })()
    const s = getSocket()
    const onDet = (evt) => {
      // Skip adding new items if paused
      if (isPaused) return
      
      setItems((arr)=>{
        const seen = new Set()
        const merged = [{ ...evt }, ...arr].filter((it)=>{
          if (!it || !it.tx || !it.trackerId) return false
          const key = `${it.tx}:${it.trackerId}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        return merged.slice(0, 500)
      })
      // optional: auto-scroll to top on new item
      try { listRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' }) } catch (_) {}
    }
    s.on('detection', onDet)
    return ()=>{ s.off('detection', onDet) }
  }, [isPaused])

  const filtered = useMemo(() => {
    let result = items
    
    // Apply status filter
    if (statusFilter === 'pass') result = result.filter(it => it.pass)
    else if (statusFilter === 'fail') result = result.filter(it => !it.pass)
    
    // Apply token filter
    if (tokenFilter === 'withTokens') result = result.filter(it => it.hasToken)
    
    return result
  }, [items, statusFilter, tokenFilter])

  return (
    <Layout title="Detections">
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h3 className="m-0 text-lg font-semibold">All Pool Detections</h3>
            <button 
              className={`btn btn-sm ${isPaused ? 'btn-warning' : 'btn-success'}`}
              onClick={() => setIsPaused(!isPaused)}
              title={isPaused ? 'Resume live updates' : 'Pause live updates'}
            >
              {isPaused ? '▶️ Resume' : '⏸️ Pause'}
            </button>
          </div>
          <div className="flex gap-4">
            {/* Status Filter */}
            <div className="flex gap-2">
              <button 
                className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : ''}`}
                onClick={() => setStatusFilter('all')}
              >
                All ({items.length})
              </button>
              <button 
                className={`btn btn-sm ${statusFilter === 'fail' ? 'btn-primary' : ''}`}
                onClick={() => setStatusFilter('fail')}
              >
                Filtered ({items.filter(it => !it.pass).length})
              </button>
            </div>
            {/* Token Filter */}
            <div className="flex gap-2 border-l pl-4">
              <button 
                className={`btn btn-sm ${tokenFilter === 'all' ? 'btn-primary' : ''}`}
                onClick={() => setTokenFilter('all')}
                title="Show all detections"
              >
                All Detections
              </button>
              <button 
                className={`btn btn-sm ${tokenFilter === 'withTokens' ? 'btn-primary' : ''}`}
                onClick={() => setTokenFilter('withTokens')}
                title="Show only detections with valid token metadata"
              >
                With Tokens ({items.filter(it => it.hasToken).length})
              </button>
            </div>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <div className="scroll-area" ref={listRef} style={{maxHeight: '70vh'}}>
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Time</th>
                <th>DEX</th>
                <th>Token</th>
                <th>Creator</th>
                <th>Pool/Pair</th>
                <th>Status/Reason</th>
                <th>Links</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, idx)=> {
                const token = e.token || e.currency1 || e.token1
                const pool = e.pool || e.pair
                const hasToken = e.hasToken !== false // default to true for backward compatibility
                return (
                  <tr key={`${e.tx}-${e.trackerId}-${idx}`} className="row-animate">
                    <td className="whitespace-nowrap text-xs">
                      {new Date(e.ts || Date.now()).toLocaleTimeString()}
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div>
                          <div className="text-sm font-medium">{e.tracker || 'Unknown'}</div>
                          {e.version && <div className="text-xs text-muted">{e.version}</div>}
                        </div>
                        {e.enabled === false && (
                          <span className="badge badge-sm" style={{backgroundColor: '#6b7280', color: 'white'}}>
                            disabled
                          </span>
                        )}
                        {!hasToken && (
                          <span className="badge badge-sm" style={{backgroundColor: '#ef4444', color: 'white'}} title="Token metadata unavailable">
                            no data
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {token ? (
                        <div>
                          <div className="font-mono text-xs">
                            {token.slice(0,6)}...{token.slice(-4)}
                          </div>
                          {hasToken && e.tokenSymbol && (
                            <div className="text-xs font-semibold">{e.tokenSymbol}</div>
                          )}
                          {hasToken && e.tokenName && (
                            <div className="text-xs text-muted">{e.tokenName}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted text-xs">—</span>
                      )}
                    </td>
                    <td>
                      {e.creator ? (
                        <div>
                          <a 
                            className="link font-mono text-xs" 
                            href={`https://basescan.org/address/${e.creator}`} 
                            target="_blank" 
                            rel="noreferrer"
                            title={e.creator}
                          >
                            {e.creator.slice(0,6)}...{e.creator.slice(-4)}
                          </a>
                          {typeof e.creatorTokens !== 'undefined' && (
                            <div className="text-xs text-muted mt-1" title="Total tokens created by this address">
                              {e.creatorTokens} total
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted text-xs">—</span>
                      )}
                    </td>
                    <td>
                      {pool ? (
                        <div className="font-mono text-xs">
                          {pool.slice(0,6)}...{pool.slice(-4)}
                        </div>
                      ) : (
                        <span className="text-muted text-xs">—</span>
                      )}
                    </td>
                    <td>
                      {e.pass ? (
                        <span className="badge badge-success text-xs">PASS</span>
                      ) : (
                        <div>
                          <span className="badge badge-warning text-xs mb-1">FILTERED</span>
                          {e.reason && (
                            <div className="text-xs text-muted" style={{maxWidth: '200px'}}>
                              {e.reason.replace(/-/g, ' ')}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        {e.dexscreener && token && (
                          <a 
                            className="link text-xs" 
                            href={e.dexscreener} 
                            target="_blank" 
                            rel="noreferrer"
                          >
                            📊 DexScreener
                          </a>
                        )}
                        {e.uniswapLink && (
                          <a 
                            className="link text-xs" 
                            href={e.uniswapLink} 
                            target="_blank" 
                            rel="noreferrer"
                          >
                            🦄 {e.dex === 'BaseSwap' ? 'BaseSwap' : 'Uniswap'}
                          </a>
                        )}
                      </div>
                    </td>
                    <td>
                      <a 
                        className="link text-xs font-mono" 
                        href={`https://basescan.org/tx/${e.tx}`} 
                        target="_blank" 
                        rel="noreferrer"
                      >
                        {e.tx.slice(0,8)}...
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-8 text-muted">
            No detections yet. Waiting for new pools...
          </div>
        )}
      </div>
    </Layout>
  )
}
