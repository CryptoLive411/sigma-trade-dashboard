import axios from 'axios'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

export function getToken() { return typeof window !== 'undefined' ? localStorage.getItem('token') : null }
export function setToken(t) { if (typeof window !== 'undefined') localStorage.setItem('token', t) }
export function clearToken() { if (typeof window !== 'undefined') localStorage.removeItem('token') }

export const api = axios.create({ baseURL: API_URL })
api.interceptors.request.use((config) => { const t = getToken(); if (t) config.headers.Authorization = `Bearer ${t}`; return config })
