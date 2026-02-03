import { useState } from 'react';
import { useApiStatus } from '@/hooks/useApiStatus';
import { WifiOff, Loader2, RefreshCw, ChevronDown, Server, Clock, Zap } from 'lucide-react';

export function ApiStatusIndicator() {
  const { isConnected, isChecking, error, latency, apiUrl, lastChecked, retry } = useApiStatus();
  const [isOpen, setIsOpen] = useState(false);

  const formatTime = (date: Date | null) => {
    if (!date) return 'Never';
    return date.toLocaleTimeString();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border hover:bg-muted/50 transition-colors"
      >
        {isChecking ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Checking...</span>
          </>
        ) : isConnected ? (
          <>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500/60"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">Connected</span>
            {latency && <span className="text-xs text-muted-foreground">{latency}ms</span>}
          </>
        ) : (
          <>
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Mock Mode</span>
          </>
        )}
        <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-card border border-border rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Backend Status</span>
              <button
                onClick={() => retry()}
                disabled={isChecking}
                className="p-1.5 rounded-md hover:bg-muted transition-colors disabled:opacity-50"
                title="Retry connection"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
              isConnected 
                ? 'bg-green-500/10 text-green-600 dark:text-green-400' 
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}>
              {isConnected ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                  Operational
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3" />
                  Offline - Using Mock Data
                </>
              )}
            </div>
          </div>
          
          <div className="p-3 space-y-2.5 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Server className="w-3.5 h-3.5" />
              <span className="truncate flex-1" title={apiUrl}>{apiUrl}</span>
            </div>
            
            {latency && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Zap className="w-3.5 h-3.5" />
                <span>Latency: <span className={latency < 200 ? 'text-green-500' : latency < 500 ? 'text-amber-500' : 'text-red-500'}>{latency}ms</span></span>
              </div>
            )}
            
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              <span>Last checked: {formatTime(lastChecked)}</span>
            </div>
            
            {error && (
              <div className="mt-2 p-2 bg-destructive/10 rounded-md text-destructive text-xs">
                {error}
              </div>
            )}
          </div>
          
          {!isConnected && (
            <div className="p-3 bg-muted/30 border-t border-border">
              <p className="text-xs text-muted-foreground">
                The backend server is unreachable. The app is running with mock data. Start your server to see live data.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
