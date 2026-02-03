import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { api, setToken } from '@/lib/api';
import { Layout } from '@/components/Layout';
import { useToast } from '@/hooks/use-toast';

const fetcher = (url: string) => api.get(url).then(r => r.data).catch(() => null);

interface SignerData {
  address?: string;
}

interface BalancesData {
  eth?: string;
  tokens?: Record<string, { raw?: string; decimals?: number }>;
}

interface RuntimeData {
  trading?: { weth?: string };
}

const MOCK_SIGNER: SignerData = { address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0Ab23' };
const MOCK_RUNTIME: RuntimeData = { trading: { weth: '0x4200000000000000000000000000000000000006' } };
const MOCK_BALANCES: BalancesData = { eth: '1500000000000000000', tokens: { '0x4200000000000000000000000000000000000006': { raw: '500000000000000000', decimals: 18 } } };

export default function Account() {
  const { data: signerRaw, mutate: refetchSigner } = useSWR<SignerData | null>('/api/account/signer', fetcher);
  const { data: runtimeRaw } = useSWR<RuntimeData | null>('/api/runtime', fetcher);
  const signer = signerRaw || MOCK_SIGNER;
  const runtime = runtimeRaw || MOCK_RUNTIME;
  const [tokensInput, setTokensInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [balances, setBalances] = useState<BalancesData | null>(MOCK_BALANCES);
  const [pk, setPk] = useState('');
  const [savingPk, setSavingPk] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);
  const { toast } = useToast();

  const tokenList = tokensInput.split(',').map(s => s.trim()).filter(Boolean);

  async function rotateKey() {
    if (!pk || pk.length < 16) return toast({ title: 'Private key looks invalid', variant: 'destructive' });
    setSavingPk(true);
    try {
      await api.post('/api/account/signer', { privateKey: pk });
      setPk('');
      await refetchSigner();
      await fetchBalances();
      toast({ title: 'Signer updated' });
    } catch (e) {
      toast({ title: 'Failed to update signer', variant: 'destructive' });
    } finally {
      setSavingPk(false);
    }
  }

  async function fetchBalances() {
    if (!signer?.address) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      for (const t of tokenList) params.append('tokens', t);
      const r = await api.get(`/api/account/balances?${params.toString()}`);
      setBalances(r.data);
    } catch (e) {
      setBalances(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (runtime?.trading?.weth && !tokensInput) setTokensInput(runtime.trading.weth);
  }, [runtime?.trading?.weth, tokensInput]);

  useEffect(() => {
    if (signer?.address) fetchBalances();
  }, [signer?.address]);

  const toEth = (w: string | undefined) => {
    const n = Number(w || 0);
    return isFinite(n) ? (n / 1e18) : 0;
  };
  const fmt = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });

  return (
    <Layout title="Account">
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <h3 className="text-lg font-semibold mb-4">Signer</h3>
        <div className="flex items-center gap-4 mb-4">
          <label className="text-sm text-muted-foreground">Address</label>
          <input
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            value={signer?.address || ''}
            readOnly
          />
        </div>
        <div className="flex items-center gap-4">
          <label className="text-sm text-muted-foreground">Rotate Private Key</label>
          <input
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            type="password"
            placeholder="0x... (never displayed)"
            value={pk}
            onChange={(e) => setPk(e.target.value)}
          />
          <button
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-60"
            onClick={rotateKey}
            disabled={savingPk}
          >
            {savingPk ? 'Updating...' : 'Update'}
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <h3 className="text-lg font-semibold mb-4">Balances</h3>
        <div className="flex items-center gap-4 mb-4">
          <label className="text-sm text-muted-foreground">ERC20 Tokens (comma-separated)</label>
          <input
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
            placeholder="0xToken1,0xToken2"
            value={tokensInput}
            onChange={(e) => setTokensInput(e.target.value)}
          />
          <button
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-60"
            onClick={fetchBalances}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Load Balances'}
          </button>
        </div>
        {!balances ? <div>No data</div> : (
          <>
            <div className="mb-4">ETH: <b>{fmt(toEth(balances.eth))}</b></div>
            {balances.tokens && Object.keys(balances.tokens).length > 0 && (
              <table className="w-full text-sm">
                <thead className="border-b border-border">
                  <tr>
                    <th className="text-left p-2">Token</th>
                    <th className="text-left p-2">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(balances.tokens).map(([addr, info]) => {
                    const dec = info?.decimals ?? 18;
                    let val = 0;
                    try { val = Number(info?.raw || 0) / Math.pow(10, dec); } catch (_) {}
                    return (
                      <tr key={addr} className="border-b border-border">
                        <td className="p-2">{addr}</td>
                        <td className="p-2">{fmt(val)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-lg font-semibold mb-2">Credentials</h3>
        <p className="text-sm text-muted-foreground mb-4">Update your username and/or password.</p>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="w-40 text-sm text-muted-foreground">Current Password</label>
            <input
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="w-40 text-sm text-muted-foreground">New Username</label>
            <input
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              placeholder="leave blank to keep same"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="w-40 text-sm text-muted-foreground">New Password</label>
            <input
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground"
              type="password"
              placeholder="leave blank to keep same"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <button
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-60"
            disabled={savingCreds}
            onClick={async () => {
              if (!currentPassword) { toast({ title: 'Enter current password', variant: 'destructive' }); return; }
              setSavingCreds(true);
              try {
                const { data } = await api.post('/api/account/credentials', {
                  currentPassword,
                  newUsername: newUsername || undefined,
                  newPassword: newPassword || undefined
                });
                if (data?.token) {
                  setToken(data.token);
                }
                toast({ title: 'Credentials updated' });
                setCurrentPassword('');
                setNewPassword('');
              } catch (e: unknown) {
                const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to update credentials';
                toast({ title: msg, variant: 'destructive' });
              } finally {
                setSavingCreds(false);
              }
            }}
          >
            {savingCreds ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </Layout>
  );
}
