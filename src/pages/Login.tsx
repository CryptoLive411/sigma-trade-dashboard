import { useState } from 'react';
import { setToken } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    
    // Simple login - accepts admin/admin123! or any non-empty credentials
    if ((username === 'admin' && password === 'admin123!') || (username.length > 0 && password.length > 0)) {
      setToken('token_' + Date.now());
      toast({ title: 'Logged in successfully' });
      window.location.href = '/dashboard';
    } else {
      toast({ 
        title: 'Please enter credentials', 
        variant: 'destructive' 
      });
      setLoading(false);
    }
  }

  function handleDevBypass() {
    setToken('dev_token_' + Date.now());
    toast({ title: 'Dev mode enabled' });
    window.location.href = '/dashboard';
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-xl p-6 shadow-lg">
          <h2 className="mt-0 text-2xl font-semibold text-foreground">Base Sniper Admin</h2>
          <form onSubmit={onSubmit} className="mt-4">
            <div className="space-y-4">
              <div>
                <label className="text-sm text-muted-foreground">Username</label>
                <input
                  className="w-full mt-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Password</label>
                <input
                  className="w-full mt-1 px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            <button
              className="w-full mt-6 px-4 py-2 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Logging in...' : 'Login'}
            </button>
          </form>
          <div className="mt-4 pt-4 border-t border-border">
            <button
              onClick={handleDevBypass}
              className="w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg hover:bg-muted/50 transition-colors"
            >
              Dev Mode (Skip Login)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
