import useSWR from 'swr'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import Layout from '../components/Layout'
import { getSocket } from '../lib/socket'
import Sparkline from '../components/Sparkline'
import PnLMap from '../components/PnLMap'

const fetcher = (url) => api.get(url).then(r=>r.data)

export default function Dashboard(){
  const { data: stats } = useSWR('/api/stats', fetcher, { refreshInterval: 5000 })
  const { data: metrics } = useSWR('/api/trackers/metrics', fetcher, { refreshInterval: 3000 })
  const [pnlSeries, setPnlSeries] = useState([])
  const [realizedHistory, setRealizedHistory] = useState([]) // realized PnL ETH over time
  const [activeHistory, setActiveHistory] = useState([]) // active exposure ETH over time

  useEffect(()=>{
    if(!metrics) return
    const toEth = (w)=>{ const n=Number(w||0); return isFinite(n)? n/1e18 : 0 }
    setRealizedHistory(h=>[...h.slice(-300), toEth(metrics.realizedPnLEthWei)])
    setActiveHistory(h=>[...h.slice(-300), toEth(metrics.activeEthWei)])
  }, [metrics])

  useEffect(()=>{
    const s = getSocket()
    const onMon = (m) => {
      const val = (typeof m?.pnlPct === 'number') ? m.pnlPct : (typeof m?.pnl === 'number' ? m.pnl : null)
      if (val!=null) setPnlSeries((arr)=>[...arr.slice(-300), val])
    }
    s.on('trade:monitor', onMon)
    return ()=>{ s.off('trade:monitor', onMon) }
  },[])

  const toEth = (wei) => {
    if (!wei) return 0
    const n = Number(wei)
    if (!isFinite(n)) return 0
    return n / 1e18
  }

  const perTrackerPnl = useMemo(()=>{
    if(!metrics) return []
    return (metrics.perTracker||[]).map(t=>({ id: t.id, name: t.name, value: toEth(t.metrics?.realizedPnLEthWei) }))
  }, [metrics])

  return (
    <Layout title="Dashboard">
      <div className="card">
        <div className="grid">
          <div className="stat">
            <div className="muted">Active Exposure</div>
            <div className="text-2xl font-bold">{metrics? toEth(metrics.activeEthWei).toFixed(6):'—'} ETH</div>
          </div>
          <div className="stat">
            <div className="muted">Realized PnL</div>
            <div className="text-2xl font-bold">{metrics? toEth(metrics.realizedPnLEthWei).toFixed(6):'—'} ETH</div>
          </div>
          <div className="stat">
            <div className="muted">Uptime</div>
            <div className="text-2xl font-bold">{stats? (stats.uptime/3600).toFixed(2):'—'} h</div>
          </div>
            <div className="stat">
            <div className="muted">Load Avg</div>
            <div className="text-2xl font-bold">{stats? stats.load?.map(n=>n.toFixed(2)).join(' / '):'—'}</div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="flex items-center justify-between">
          <h3 className="m-0 text-lg font-semibold">Per-Tracker Metrics</h3>
          <a className="btn" href="/trackers">Manage Trackers</a>
        </div>
        {!metrics ? <div>Loading...</div> : (
          <table className="table mt-2">
            <thead><tr><th>Tracker</th><th>Active (ETH)</th><th>Realized PnL (ETH)</th></tr></thead>
            <tbody>
              {(metrics.perTracker||[]).map(t => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{toEth(t.metrics?.activeEthWei).toFixed(6)}</td>
                  <td>{toEth(t.metrics?.realizedPnLEthWei).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="flex items-center justify-between">
          <h3 className="m-0 text-lg font-semibold">Live PnL % Sparkline</h3>
          <span className="muted text-xs">Samples: {pnlSeries.length}</span>
        </div>
        <div className="mt-2">
          <Sparkline data={pnlSeries} width={500} height={60} color="#38bdf8" fill="rgba(56,189,248,0.12)" />
        </div>
      </div>
      <div className="card grid md:grid-cols-2 gap-6">
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
      <div className="card">
        <h3 className="m-0 text-lg font-semibold">Per-Tracker Realized PnL Map</h3>
        <div className="mt-3">
          <PnLMap items={perTrackerPnl} />
        </div>
      </div>
    </Layout>
  )
}
