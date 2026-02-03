import { io, Socket } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.reachsniperbot.site';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, { transports: ['websocket'], autoConnect: true });
  }
  return socket;
}
