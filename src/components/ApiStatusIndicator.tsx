import { useApiStatus } from '@/hooks/useApiStatus';
import { WifiOff, Loader2 } from 'lucide-react';

export function ApiStatusIndicator() {
  const { isConnected, isChecking, error } = useApiStatus();

  return (
    <div className="flex items-center gap-2">
      {isChecking ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Checking...</span>
        </>
      ) : isConnected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/60"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          <span className="text-xs text-primary">API Connected</span>
        </>
      ) : (
        <>
          <WifiOff className="w-4 h-4 text-destructive" />
          <span className="text-xs text-destructive" title={error || 'Using mock data'}>
            Mock Mode
          </span>
        </>
      )}
    </div>
  );
}
