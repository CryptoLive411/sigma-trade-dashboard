import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { api, setToken } from '../lib/api'
import Layout from '../components/Layout'
import toast from 'react-hot-toast'

const fetcher = (url) => api.get(url).then(r=>r.data)

export default function Account(){
  const { data: signer, mutate: refetchSigner } = useSWR('/api/account/signer', fetcher)
  const { data: runtime } = useSWR('/api/runtime', fetcher)
  const [tokensInput, setTokensInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [balances, setBalances] = useState(null)
  const [pk, setPk] = useState('')
  const [savingPk, setSavingPk] = useState(false)
  // credentials state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [savingCreds, setSavingCreds] = useState(false)

  const tokenList = useMemo(()=> tokensInput.split(',').map(s=>s.trim()).filter(Boolean), [tokensInput])

  async function rotateKey(){
    if (!pk || pk.length < 16) return alert('Private key looks invalid')
    setSavingPk(true)
    try {
      await api.post('/api/account/signer', { privateKey: pk })
      setPk('')
      await refetchSigner()
      await fetchBalances()
      toast.success('Signer updated')
    } catch (e) {
      toast.error('Failed to update signer')
    } finally {
      setSavingPk(false)
    }
  }

  async function fetchBalances(){
    if (!signer?.address) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      for (const t of tokenList) params.append('tokens', t)
      const r = await api.get(`/api/account/balances?${params.toString()}`)
      setBalances(r.data)
    } catch (e) {
      setBalances(null)
    } finally {
      setLoading(false)
    }
  }

  // Prefill tokens with WETH from runtime and auto-fetch when signer or token list changes
  useEffect(()=>{
    if (runtime?.trading?.weth && !tokensInput) setTokensInput(runtime.trading.weth)
  }, [runtime?.trading?.weth])

  useEffect(()=>{ if (signer?.address) fetchBalances() }, [signer?.address, tokensInput])

  const toEth = (w) => {
    const n = Number(w||0)
    return isFinite(n) ? (n/1e18) : 0
  }
  const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 })

  return (
    <Layout title="Account">
      <div className="card">
        <h3 className="text-lg font-semibold">Signer</h3>
        <div className="row">
          <label>Address</label>
          <input className="input" value={signer?.address || ''} readOnly />
        </div>
        <div className="row">
          <label>Rotate Private Key</label>
          <input className="input" type="password" placeholder="0x... (never displayed)" value={pk} onChange={(e)=>setPk(e.target.value)} />
          <button className="btn" onClick={rotateKey} disabled={savingPk}>{savingPk? 'Updating...':'Update'}</button>
        </div>
  </div>

  <div className="card">
        <h3 className="text-lg font-semibold">Balances</h3>
        <div className="row">
          <label>ERC20 Tokens (comma-separated)</label>
          <input className="input" placeholder="0xToken1,0xToken2" value={tokensInput} onChange={(e)=>setTokensInput(e.target.value)} />
          <button className="btn" onClick={fetchBalances} disabled={loading}>{loading?'Loading...':'Load Balances'}</button>
        </div>
        {!balances ? <div className="mt-2">No data</div> : (
          <>
            <div className="row mt-2">
              <div>ETH: <b>{fmt(toEth(balances.eth))}</b></div>
            </div>
            {balances.tokens && Object.keys(balances.tokens).length > 0 && (
            <table className="table mt-2">
              <thead><tr><th>Token</th><th>Balance</th></tr></thead>
              <tbody>
                {Object.entries(balances.tokens||{}).map(([addr, info])=>{
                  const dec = info?.decimals ?? 18
                  let val = 0
                  try { val = Number(info?.raw || 0) / Math.pow(10, dec) } catch(_) {}
                  return (
                    <tr key={addr}>
                      <td>{addr}</td>
                      <td>{fmt(val)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold">Credentials</h3>
        <p className="muted text-sm">Update your username and/or password. You'll be signed in again automatically.</p>
        <div className="row">
          <label>Current Password</label>
          <input className="input" type="password" value={currentPassword} onChange={(e)=>setCurrentPassword(e.target.value)} />
        </div>
        <div className="row">
          <label>New Username</label>
          <input className="input" placeholder="leave blank to keep same" value={newUsername} onChange={(e)=>setNewUsername(e.target.value)} />
        </div>
        <div className="row">
          <label>New Password</label>
          <input className="input" type="password" placeholder="leave blank to keep same" value={newPassword} onChange={(e)=>setNewPassword(e.target.value)} />
        </div>
        <div className="row">
          <button className="btn" disabled={savingCreds} onClick={async ()=>{
            if (!currentPassword) { toast.error('Enter current password'); return }
            setSavingCreds(true)
            try {
              const { data } = await api.post('/api/account/credentials', { currentPassword, newUsername: newUsername || undefined, newPassword: newPassword || undefined })
              if (data?.token) {
                setToken(data.token)
              }
              toast.success('Credentials updated')
              setCurrentPassword(''); setNewPassword('');
            } catch (e) {
              const msg = e?.response?.data?.error || 'Failed to update credentials'
              toast.error(msg)
            } finally {
              setSavingCreds(false)
            }
          }}>{savingCreds ? 'Saving...' : 'Save Changes'}</button>
        </div>
      </div>
    </Layout>
  )
}
