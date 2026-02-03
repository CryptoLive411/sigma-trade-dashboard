import { io } from 'socket.io-client'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'
let socket

export function getSocket(){
  if (!socket) {
    socket = io(API_URL, { transports: ['websocket'], autoConnect: true })
  }
  return socket
}
