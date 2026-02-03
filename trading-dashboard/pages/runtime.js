import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import Layout from '../components/Layout'
import toast from 'react-hot-toast'

export default function Runtime(){
  const [data, setData] = useState(null)
  const [saving, setSaving] = useState(false)
  useEffect(()=>{ api.get('/api/runtime').then(r=>setData(r.data)) },[])
  async function save(){
    setSaving(true)
    try {
      const r = await api.put('/api/runtime', data)
      setData(r.data)
      toast.success('Runtime saved')
    } catch (e) {
      toast.error('Failed to save runtime')
    } finally {
      setSaving(false)
    }
  }
  if(!data) return <Layout title="Runtime Config"><div className="card">Loading...</div></Layout>
  return (
    <Layout title="Runtime Config">
      <div className="card">
        <div className="grid">
          <div>
            <div className="muted">RPC URL</div>
            <input className="input" style={{width:'100%'}} value={data.chainRpc} onChange={(e)=>setData({...data, chainRpc:e.target.value})} />
          </div>
          <div>
            <div className="muted">Buy ETH Amount</div>
            <input className="input" value={data.trading.buyEthAmount} onChange={(e)=>setData({...data, trading:{...data.trading, buyEthAmount: e.target.value}})} />
          </div>
          <div>
            <div className="muted">Profit %</div>
            <input className="input" type="number" step="0.1" value={data.trading.sellProfitPct} onChange={(e)=>setData({...data, trading:{...data.trading, sellProfitPct: Number(e.target.value)}})} />
          </div>
          <div>
            <div className="muted">Loss %</div>
            <input className="input" type="number" step="0.1" value={data.trading.sellLossPct} onChange={(e)=>setData({...data, trading:{...data.trading, sellLossPct: Number(e.target.value)}})} />
          </div>
          <div>
            <div className="muted">Max Hold (seconds)</div>
            <input className="input" type="number" value={data.trading.sellMaxHoldSeconds} onChange={(e)=>setData({...data, trading:{...data.trading, sellMaxHoldSeconds: Number(e.target.value)}})} />
          </div>
        </div>
    <div className="grid mt-3">
          <div>
            <div className="muted">Global Include (comma-separated addresses)</div>
            <input className="input" style={{width:'100%'}} value={(data.include?.global||[]).join(',')} onChange={(e)=>{
              const parts = e.target.value.split(',').map(s=>s.trim()).filter(Boolean)
              setData({...data, include: { ...(data.include||{}), global: parts } })
            }} />
          </div>
          <div>
            <div className="muted">Global Blacklist (comma-separated addresses)</div>
            <input className="input" style={{width:'100%'}} value={(data.blacklist?.global||[]).join(',')} onChange={(e)=>{
              const parts = e.target.value.split(',').map(s=>s.trim()).filter(Boolean)
              setData({...data, blacklist: { ...(data.blacklist||{}), global: parts } })
            }} />
          </div>
        </div>
    <div className="grid mt-3">
          <div>
      <h4 className="my-2 font-semibold">Default Tracker Priorities</h4>
            <div className="row">
              {['UniswapV2','UniswapV3','UniswapV4','ApeStore'].map((k)=> (
                <div key={k} className="row" style={{gap:6}}>
                  <label className="muted" style={{minWidth:90}}>{k}</label>
                  <input className="input" type="number" value={data.priorities?.[k] ?? 0}
                    onChange={(e)=>setData({...data, priorities: { ...(data.priorities||{}), [k]: Number(e.target.value) }})}
                    style={{width:90}} />
                </div>
              ))}
            </div>
          </div>
          <div>
      <h4 className="my-2 font-semibold">Tracker Defaults</h4>
            <div className="row">
              <label className="muted">maxActiveBuyEth</label>
              <input className="input" value={data.trackerDefaults?.maxActiveBuyEth || '0'} onChange={(e)=>setData({...data, trackerDefaults: { ...(data.trackerDefaults||{}), maxActiveBuyEth: e.target.value }})} />
            </div>
      <div className="grid mt-2">
              <div>
                <div className="muted">Override buyEthAmount</div>
                <input className="input" value={data.trackerDefaults?.trading?.buyEthAmount || ''} onChange={(e)=>setData({...data, trackerDefaults: { ...(data.trackerDefaults||{}), trading: { ...(data.trackerDefaults?.trading||{}), buyEthAmount: e.target.value } }})} />
              </div>
              <div>
                <div className="muted">Override sellProfitPct</div>
                <input className="input" type="number" step="0.1" value={data.trackerDefaults?.trading?.sellProfitPct ?? ''} onChange={(e)=>setData({...data, trackerDefaults: { ...(data.trackerDefaults||{}), trading: { ...(data.trackerDefaults?.trading||{}), sellProfitPct: Number(e.target.value) } }})} />
              </div>
              <div>
                <div className="muted">Override sellLossPct</div>
                <input className="input" type="number" step="0.1" value={data.trackerDefaults?.trading?.sellLossPct ?? ''} onChange={(e)=>setData({...data, trackerDefaults: { ...(data.trackerDefaults||{}), trading: { ...(data.trackerDefaults?.trading||{}), sellLossPct: Number(e.target.value) } }})} />
              </div>
              <div>
                <div className="muted">Override sellMaxHoldSeconds</div>
                <input className="input" type="number" value={data.trackerDefaults?.trading?.sellMaxHoldSeconds ?? ''} onChange={(e)=>setData({...data, trackerDefaults: { ...(data.trackerDefaults||{}), trading: { ...(data.trackerDefaults?.trading||{}), sellMaxHoldSeconds: Number(e.target.value) } }})} />
              </div>
            </div>
          </div>
        </div>
    <div className="row mt-3">
          <button className="btn" onClick={save} disabled={saving}>{saving? 'Saving...':'Save'}</button>
        </div>
      </div>
    </Layout>
  )
}
