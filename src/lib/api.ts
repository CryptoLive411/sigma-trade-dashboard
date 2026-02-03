import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.reachsniperbot.site';

export function getToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem('token') : null;
}

export function setToken(t: string): void {
  if (typeof window !== 'undefined') localStorage.setItem('token', t);
}

export function clearToken(): void {
  if (typeof window !== 'undefined') localStorage.removeItem('token');
}

export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const t = getToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});
