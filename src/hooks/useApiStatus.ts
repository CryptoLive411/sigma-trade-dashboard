import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';

export interface ApiStatus {
  isConnected: boolean;
  isChecking: boolean;
  lastChecked: Date | null;
  error: string | null;
  latency: number | null;
  apiUrl: string;
}

export function useApiStatus(checkInterval = 30000) {
  const apiUrl = import.meta.env.VITE_API_URL || 'https://api.reachsniperbot.site';
  
  const [status, setStatus] = useState<ApiStatus>({
    isConnected: false,
    isChecking: true,
    lastChecked: null,
    error: null,
    latency: null,
    apiUrl,
  });

  const checkConnection = useCallback(async () => {
    setStatus(prev => ({ ...prev, isChecking: true }));
    const startTime = Date.now();
    
    try {
      const response = await api.get('/health', { timeout: 5000 });
      const latency = Date.now() - startTime;
      setStatus({
        isConnected: response.data?.ok === true || response.status === 200,
        isChecking: false,
        lastChecked: new Date(),
        error: null,
        latency,
        apiUrl,
      });
    } catch (err: any) {
      setStatus({
        isConnected: false,
        isChecking: false,
        lastChecked: new Date(),
        error: err?.code === 'ECONNABORTED' ? 'Timeout' : (err?.message || 'Connection failed'),
        latency: null,
        apiUrl,
      });
    }
  }, [apiUrl]);

  useEffect(() => {
    let mounted = true;

    const check = async () => {
      if (mounted) await checkConnection();
    };

    check();
    const interval = setInterval(check, checkInterval);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [checkInterval, checkConnection]);

  return { ...status, retry: checkConnection };
}
