import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

export interface ApiStatus {
  isConnected: boolean;
  isChecking: boolean;
  lastChecked: Date | null;
  error: string | null;
}

export function useApiStatus(checkInterval = 30000) {
  const [status, setStatus] = useState<ApiStatus>({
    isConnected: false,
    isChecking: true,
    lastChecked: null,
    error: null,
  });

  useEffect(() => {
    let mounted = true;

    const checkConnection = async () => {
      if (!mounted) return;
      
      setStatus(prev => ({ ...prev, isChecking: true }));
      
      try {
        const response = await api.get('/health', { timeout: 5000 });
        if (mounted) {
          setStatus({
            isConnected: response.data?.ok === true,
            isChecking: false,
            lastChecked: new Date(),
            error: null,
          });
        }
      } catch (err: any) {
        if (mounted) {
          setStatus({
            isConnected: false,
            isChecking: false,
            lastChecked: new Date(),
            error: err?.message || 'Connection failed',
          });
        }
      }
    };

    // Initial check
    checkConnection();

    // Periodic checks
    const interval = setInterval(checkConnection, checkInterval);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [checkInterval]);

  return status;
}
