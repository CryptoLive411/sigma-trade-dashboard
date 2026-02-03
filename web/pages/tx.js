import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { api } from '../lib/api'
import Layout from '../components/Layout'
import { getSocket } from '../lib/socket'

const fetcher = (url) => api.get(url).then(r=>r.data)

export default function Tx(){
  const { data: initial } = useSWR('/api/tx', fetcher)
  const [events, setEvents] = useState([])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(null)
  useEffect(()=>{ if (initial && !events.length) setEvents(initial.slice().reverse().map(x=>({ ...x, type: x.type || x.phase }))) }, [initial])
  useEffect(()=>{
    const s = getSocket()
    const add = (type) => (payload) => setEvents((arr)=>[
      { type, time: Date.now(), ...payload },
      ...arr
    ].slice(0,500))
    s.on('tx:sent', add('sent'))
    s.on('tx:confirmed', add('confirmed'))
    s.on('tx:error', add('error'))
    return ()=>{ s.off('tx:sent'); s.off('tx:confirmed'); s.off('tx:error') }
  },[])
  const rows = useMemo(()=>{
    const f = (filter||'').toLowerCase()
    return events.filter(e=> !f || (e.hash||'').toLowerCase().includes(f) || (e.label||'').toLowerCase().includes(f)).slice(0,200)
  },[events, filter])
  return (
    <Layout title="Transactions">
      <div className="card">
        <div className="flex items-center justify-between gap-3">
          <input className="input" placeholder="Filter by hash/label" value={filter} onChange={(e)=>setFilter(e.target.value)} />
          <div className="muted">{events.length} events</div>
        </div>
        <table className="table mt-2">
          <thead>
            <tr><th>Time</th><th>Type</th><th>Label</th><th>Hash</th><th>Address</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map((e, i)=> (
              <tr key={(e.hash||'')+i} onClick={()=>setSelected(e)} className="cursor-pointer hover:bg-slate-800/40">
                <td>{new Date(e.time||Date.now()).toLocaleTimeString()}</td>
                <td>{e.type}</td>
                <td>{e.label||''}</td>
                <td className="mono">{(e.hash||'').slice(0,10)}…</td>
                <td className="mono">{e.address? e.address.slice(0,8)+'…':''}</td>
                <td>{e.status!=null? String(e.status): (e.error? 'error':'')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <div className="card">
          <div className="flex items-center justify-between">
            <h3 className="m-0 text-lg font-semibold">Tx Details</h3>
            <button className="btn" onClick={()=>setSelected(null)}>Close</button>
          </div>
          <div className="row mt-2">
            <div><span className="muted">Type</span> <span className="pill">{selected.type}</span></div>
            <div><span className="muted">Label</span> <span className="pill">{selected.label||'—'}</span></div>
            <div className="mono"><span className="muted">Hash</span> {selected.hash||'—'}</div>
          </div>
          <div className="grid mt-2">
            <div>
              <div className="muted">Request</div>
              <table className="table">
                <tbody>
                  <tr><td>To</td><td className="mono">{selected.request?.to||'—'}</td></tr>
                  <tr><td>Value</td><td className="mono">{selected.request?.value? Number(selected.request.value)/1e18 : '0'} ETH</td></tr>
                  <tr><td>Gas Limit</td><td className="mono">{selected.request?.gasLimit||'—'}</td></tr>
                  <tr><td>Nonce</td><td className="mono">{selected.request?.nonce??'—'}</td></tr>
                  <tr><td>Data</td><td className="mono">{selected.request?.data? (selected.request.data.slice(0,18)+'…'):'—'}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <div className="muted">Receipt</div>
              <table className="table">
                <tbody>
                  <tr><td>Status</td><td className="mono">{selected.receipt?.status!=null? String(selected.receipt.status):'—'}</td></tr>
                  <tr><td>Block</td><td className="mono">{selected.receipt?.blockNumber??'—'}</td></tr>
                  <tr><td>Gas Used</td><td className="mono">{selected.receipt?.gasUsed||'—'}</td></tr>
                  <tr><td>Cumulative Gas</td><td className="mono">{selected.receipt?.cumulativeGasUsed||'—'}</td></tr>
                  <tr><td>Logs</td><td className="mono">{Array.isArray(selected.receipt?.logs)? selected.receipt.logs.length : '—'}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
