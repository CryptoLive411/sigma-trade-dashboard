import { useState } from 'react'
import { api, setToken } from '../lib/api'
import toast from 'react-hot-toast'

export default function Login() {
  const [username, setU] = useState('')
  const [password, setP] = useState('')
  const [err, setErr] = useState('')
  async function onSubmit(e){
    e.preventDefault(); setErr('');
    try {
      const { data } = await api.post('/api/auth/login', { username, password });
      setToken(data.token);
      toast.success('Logged in');
      window.location.href='/dashboard'
    } catch (e) {
      setErr('Login failed');
      toast.error('Login failed');
    }
  }
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="card">
          <h2 className="mt-0 text-2xl font-semibold">Base Sniper Admin</h2>
          <form onSubmit={onSubmit} className="mt-3">
            <div className="space-y-3">
              <div>
                <label className="muted text-sm">Username</label>
                <input className="input mt-1" value={username} onChange={(e)=>setU(e.target.value)} />
              </div>
              <div>
                <label className="muted text-sm">Password</label>
                <input className="input mt-1" type="password" value={password} onChange={(e)=>setP(e.target.value)} />
              </div>
            </div>
            <button className="btn w-full mt-4" type="submit">Login</button>
          </form>
          {err && <p className="text-rose-400 mt-3">{err}</p>}
        </div>
      </div>
    </div>
  )
}
