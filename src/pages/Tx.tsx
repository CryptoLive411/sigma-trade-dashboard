import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { api } from '@/lib/api';
import { Layout } from '@/components/Layout';
import { getSocket } from '@/lib/socket';

interface TxEvent {
  type: string;
  time: number;
  hash?: string;
  label?: string;
  address?: string;
  status?: number;
  error?: string;
  phase?: string;
  request?: {
    to?: string;
    value?: string;
    gasLimit?: string;
    nonce?: number;
    data?: string;
  };
  receipt?: {
    status?: number;
    blockNumber?: number;
    gasUsed?: string;
    cumulativeGasUsed?: string;
    logs?: unknown[];
  };
}

// Fetcher moved inline with fallback

const MOCK_TX: TxEvent[] = [
  { type: 'sent', time: Date.now() - 60000, hash: '0xabc123def456789012345678901234567890abcdef', label: 'buy', address: '0x4200000000000000000000000000000000000006', status: 1 },
  { type: 'confirmed', time: Date.now() - 55000, hash: '0xabc123def456789012345678901234567890abcdef', label: 'buy', status: 1, receipt: { status: 1, blockNumber: 12345678, gasUsed: '150000' } },
  { type: 'sent', time: Date.now() - 30000, hash: '0xdef789abc123456789012345678901234567890123', label: 'sell', address: '0x1234567890abcdef1234567890abcdef12345678', status: 1 },
  { type: 'confirmed', time: Date.now() - 25000, hash: '0xdef789abc123456789012345678901234567890123', label: 'sell', status: 1, receipt: { status: 1, blockNumber: 12345680, gasUsed: '120000' } },
];

export default function Tx() {
  const { data: initial } = useSWR<TxEvent[]>('/api/tx', (url) => api.get(url).then(r => r.data).catch(() => MOCK_TX));
  const [events, setEvents] = useState<TxEvent[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<TxEvent | null>(null);

  useEffect(() => {
    if (initial && !events.length) setEvents(initial.slice().reverse().map(x => ({ ...x, type: x.type || x.phase || '' })));
  }, [initial, events.length]);

  useEffect(() => {
    const s = getSocket();
    const add = (type: string) => (payload: Partial<TxEvent>) => setEvents((arr) => [
      { type, time: Date.now(), ...payload } as TxEvent,
      ...arr
    ].slice(0, 500));
    s.on('tx:sent', add('sent'));
    s.on('tx:confirmed', add('confirmed'));
    s.on('tx:error', add('error'));
    return () => { s.off('tx:sent'); s.off('tx:confirmed'); s.off('tx:error'); };
  }, []);

  const rows = useMemo(() => {
    const f = (filter || '').toLowerCase();
    return events.filter(e => !f || (e.hash || '').toLowerCase().includes(f) || (e.label || '').toLowerCase().includes(f)).slice(0, 200);
  }, [events, filter]);

  return (
    <Layout title="Transactions">
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <input
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            placeholder="Filter by hash/label"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="text-muted-foreground text-sm">{events.length} events</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className="text-left p-2">Time</th>
                <th className="text-left p-2">Type</th>
                <th className="text-left p-2">Label</th>
                <th className="text-left p-2">Hash</th>
                <th className="text-left p-2">Address</th>
                <th className="text-left p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr
                  key={(e.hash || '') + i}
                  onClick={() => setSelected(e)}
                  className="cursor-pointer hover:bg-muted/50 border-b border-border"
                >
                  <td className="p-2">{new Date(e.time || Date.now()).toLocaleTimeString()}</td>
                  <td className="p-2">{e.type}</td>
                  <td className="p-2">{e.label || ''}</td>
                  <td className="p-2 font-mono">{(e.hash || '').slice(0, 10)}…</td>
                  <td className="p-2 font-mono">{e.address ? e.address.slice(0, 8) + '…' : ''}</td>
                  <td className="p-2">{e.status != null ? String(e.status) : (e.error ? 'error' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="bg-card border border-border rounded-xl p-4 mt-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="m-0 text-lg font-semibold">Tx Details</h3>
            <button
              className="px-3 py-1 bg-primary text-primary-foreground rounded-lg text-sm"
              onClick={() => setSelected(null)}
            >
              Close
            </button>
          </div>
          <div className="flex flex-wrap gap-4 mb-4">
            <div><span className="text-muted-foreground">Type</span> <span className="px-2 py-0.5 bg-muted rounded">{selected.type}</span></div>
            <div><span className="text-muted-foreground">Label</span> <span className="px-2 py-0.5 bg-muted rounded">{selected.label || '—'}</span></div>
            <div className="font-mono"><span className="text-muted-foreground">Hash</span> {selected.hash || '—'}</div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <div className="text-muted-foreground mb-2">Request</div>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b border-border"><td className="p-2">To</td><td className="p-2 font-mono">{selected.request?.to || '—'}</td></tr>
                  <tr className="border-b border-border"><td className="p-2">Value</td><td className="p-2 font-mono">{selected.request?.value ? Number(selected.request.value) / 1e18 : '0'} ETH</td></tr>
                  <tr className="border-b border-border"><td className="p-2">Gas Limit</td><td className="p-2 font-mono">{selected.request?.gasLimit || '—'}</td></tr>
                  <tr className="border-b border-border"><td className="p-2">Nonce</td><td className="p-2 font-mono">{selected.request?.nonce ?? '—'}</td></tr>
                  <tr><td className="p-2">Data</td><td className="p-2 font-mono">{selected.request?.data ? (selected.request.data.slice(0, 18) + '…') : '—'}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <div className="text-muted-foreground mb-2">Receipt</div>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b border-border"><td className="p-2">Status</td><td className="p-2 font-mono">{selected.receipt?.status != null ? String(selected.receipt.status) : '—'}</td></tr>
                  <tr className="border-b border-border"><td className="p-2">Block</td><td className="p-2 font-mono">{selected.receipt?.blockNumber ?? '—'}</td></tr>
                  <tr className="border-b border-border"><td className="p-2">Gas Used</td><td className="p-2 font-mono">{selected.receipt?.gasUsed || '—'}</td></tr>
                  <tr className="border-b border-border"><td className="p-2">Cumulative Gas</td><td className="p-2 font-mono">{selected.receipt?.cumulativeGasUsed || '—'}</td></tr>
                  <tr><td className="p-2">Logs</td><td className="p-2 font-mono">{Array.isArray(selected.receipt?.logs) ? selected.receipt.logs.length : '—'}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
