import Link from 'next/link'
import { clearToken } from '../lib/api'
import { Cog6ToothIcon, ChartBarIcon, ArrowTopRightOnSquareIcon, Squares2X2Icon, UserIcon, EyeIcon } from '@heroicons/react/24/outline'

export default function Layout({ children, title }){
  return (
    <div>
      <header className="topbar">
        <div className="container flex items-center justify-between py-3">
          <div className="flex items-center gap-4">
            <Link className="brand text-lg" href="/dashboard">Base Sniper</Link>
            <nav className="hidden sm:flex items-center gap-3">
              <Link className="nav inline-flex items-center gap-1" href="/trackers"><Squares2X2Icon className="w-4 h-4"/>Trackers</Link>
              <Link className="nav inline-flex items-center gap-1" href="/runtime"><Cog6ToothIcon className="w-4 h-4"/>Runtime</Link>
              <Link className="nav inline-flex items-center gap-1" href="/trades"><ChartBarIcon className="w-4 h-4"/>Trades</Link>
              <Link className="nav inline-flex items-center gap-1" href="/detections"><EyeIcon className="w-4 h-4"/>Detections</Link>
              <Link className="nav inline-flex items-center gap-1" href="/tx"><ArrowTopRightOnSquareIcon className="w-4 h-4"/>Tx</Link>
              <Link className="nav inline-flex items-center gap-1" href="/account"><UserIcon className="w-4 h-4"/>Account</Link>
            </nav>
          </div>
          <a className="btn btn-outline" href="/" onClick={(e)=>{ e.preventDefault(); clearToken(); window.location.href='/' }}>Logout</a>
        </div>
      </header>
      <main className="container pt-6">
        {title && <div className="card"><h2 className="m-0 text-xl font-semibold">{title}</h2></div>}
        {children}
      </main>
    </div>
  )
}
