#!/usr/bin/env python3
"""
Discord to Telegram Mirror Relay Worker
========================================
Watches Discord channels via browser automation (Playwright) using MutationObserver
for real-time message detection, and relays messages to Telegram via MTProto (Telethon).

Architecture:
- Opens one browser tab per Discord channel
- Injects MutationObserver to detect new messages instantly (<100ms)
- No polling — event-driven message detection

Run with: python discord_telegram_relay.py
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import signal
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import httpx
from dotenv import load_dotenv
from playwright.async_api import async_playwright, Browser, Page, BrowserContext
from telethon import TelegramClient
from telethon.tl.types import InputPeerChannel, InputPeerChat

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('relay.log')
    ]
)
logger = logging.getLogger('discord_relay')

# ============================================================================
@dataclass
class Config:
    """Application configuration from environment variables."""
    worker_api_key: str
    supabase_url: str
    telegram_api_id: int
    telegram_api_hash: str
    telegram_session_name: str = "discord_mirror_session"
    channel_refresh_interval: int = 60  # seconds between checking for new/removed channels
    headless: bool = True   # Run browser in headless mode
    browser_profile_path: str = "./discord_profile"

    @classmethod
    def from_env(cls) -> 'Config':
        """Load configuration from environment variables."""
        required = ['WORKER_API_KEY', 'SUPABASE_URL', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH']
        missing = [key for key in required if not os.getenv(key)]
        if missing:
            raise ValueError(f"Missing required environment variables: {', '.join(missing)}")

        return cls(
            worker_api_key=os.getenv('WORKER_API_KEY'),
            supabase_url=os.getenv('SUPABASE_URL'),
            telegram_api_id=int(os.getenv('TELEGRAM_API_ID')),
            telegram_api_hash=os.getenv('TELEGRAM_API_HASH'),
            telegram_session_name=os.getenv('TELEGRAM_SESSION_NAME', 'discord_mirror_session'),
            channel_refresh_interval=int(os.getenv('CHANNEL_REFRESH_INTERVAL', '60')),
            headless=os.getenv('HEADLESS', 'true').lower() == 'true',
            browser_profile_path=os.getenv('BROWSER_PROFILE_PATH', './discord_profile'),
        )


# ============================================================================
class APIClient:
    """Client for communicating with Supabase edge functions."""

    def __init__(self, config: Config):
        self.config = config
        self.base_url = f"{config.supabase_url}/functions/v1"
        self.headers = {
            "Authorization": f"Bearer {config.worker_api_key}",
            "Content-Type": "application/json"
        }
        self.client = httpx.AsyncClient(timeout=30.0)

    async def get_channels(self) -> list[dict]:
        """Fetch enabled Discord channels to watch."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_channels"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('channels', [])
        except Exception as e:
            logger.error(f"Failed to fetch channels: {e}")
            return []

    async def get_pending_messages(self) -> list[dict]:
        """Fetch messages pending to be sent to Telegram."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_pending_messages"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('messages', [])
        except Exception as e:
            logger.error(f"Failed to fetch pending messages: {e}")
            return []

    async def get_telegram_config(self) -> Optional[dict]:
        """Fetch Telegram destination configuration."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_telegram_config"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('config')
        except Exception as e:
            logger.error(f"Failed to fetch Telegram config: {e}")
            return None

    async def get_banned_authors(self) -> list[str]:
        """Fetch global blacklist of banned Discord usernames."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_banned_authors"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('authors', [])
        except Exception as e:
            logger.error(f"Failed to fetch banned authors: {e}")
            return []

    async def get_pending_commands(self) -> list[dict]:
        """Fetch pending commands from the dashboard."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_pending_commands"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('commands', [])
        except Exception as e:
            logger.error(f"Failed to fetch pending commands: {e}")
            return []

    async def get_trading_config(self) -> Optional[dict]:
        """Fetch trading configuration (channel allocations)."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_trading_config"},
                headers=self.headers
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Failed to fetch trading config: {e}")
            return None

    async def get_pending_sigma_trades(self) -> list[dict]:
        """Fetch trades pending Jupiter execution."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_pending_sigma_trades"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('trades', [])
        except Exception as e:
            logger.error(f"Failed to fetch pending trades: {e}")
            return []

    async def update_trade_bought(self, trade_id: str, signature: str, expected_tokens: int = None) -> bool:
        """Mark a trade as bought with TX signature."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "update_trade_bought"},
                headers=self.headers,
                json={
                    "trade_id": trade_id,
                    "signature": signature,
                    "expected_tokens": expected_tokens
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to update trade as bought: {e}")
            return False

    async def update_trade_failed(self, trade_id: str, error_message: str) -> bool:
        """Mark a trade as failed with error message."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "update_trade_failed"},
                headers=self.headers,
                json={"trade_id": trade_id, "error_message": error_message}
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to update trade as failed: {e}")
            return False

    async def get_pending_sells(self) -> list[dict]:
        """Fetch pending sell requests for Jupiter execution."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_pending_sells"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('sells', [])
        except Exception as e:
            logger.error(f"Failed to fetch pending sells: {e}")
            return []

    async def update_sell_executed(self, sell_id: str, tx_hash: str, realized_sol: float) -> bool:
        """Mark a sell request as executed with TX hash."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "update_sell_executed"},
                headers=self.headers,
                json={
                    "sell_id": sell_id,
                    "tx_hash": tx_hash,
                    "realized_sol": realized_sol
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to update sell as executed: {e}")
            return False

    async def update_sell_failed(self, sell_id: str, error_message: str) -> bool:
        """Mark a sell request as failed."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "update_sell_failed"},
                headers=self.headers,
                json={"sell_id": sell_id, "error_message": error_message}
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to update sell as failed: {e}")
            return False

    async def queue_trade_ca(self, token_address: str, chain: str, channel_id: str, 
                             channel_name: str, channel_category: str, author: str,
                             message_preview: str) -> bool:
        """Queue a detected CA for trading. Categories: under-100k, memecoin-chat, memecoin-alpha, other"""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "queue_trade_ca"},
                headers=self.headers,
                json={
                    "token_address": token_address,
                    "chain": chain,
                    "channel_id": channel_id,
                    "channel_name": channel_name,
                    "channel_category": channel_category,
                    "author": author,
                    "message_preview": message_preview
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to queue trade CA: {e}")
            return False

    async def get_open_positions(self) -> list[dict]:
        """Fetch open positions for monitoring."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "get_open_positions"},
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('positions', [])
        except Exception as e:
            logger.error(f"Failed to fetch open positions: {e}")
            return []

    async def update_position_price(self, trade_id: str, current_price: float, current_value_sol: float = None, highest_price: float = None) -> Optional[dict]:
        """Update position price, highest price for trailing stop, and check for auto-sell triggers."""
        try:
            payload = {
                "trade_id": trade_id,
                "current_price": current_price,
                "current_value_sol": current_value_sol
            }
            if highest_price is not None:
                payload["highest_price"] = highest_price

            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "update_position_price"},
                headers=self.headers,
                json=payload
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Failed to update position price: {e}")
            return None

    async def trigger_auto_sell(self, trade_id: str, percentage: int, reason: str) -> bool:
        """Trigger an auto-sell for a position."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "trigger_auto_sell"},
                headers=self.headers,
                json={
                    "trade_id": trade_id,
                    "percentage": percentage,
                    "reason": reason
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to trigger auto-sell: {e}")
            return False

    async def update_partial_tp1(self, trade_id: str) -> bool:
        """Update trade status to partial_tp1 after TP1 hit."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "update_partial_tp1"},
                headers=self.headers,
                json={"trade_id": trade_id}
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to update partial TP1: {e}")
            return False

    async def ack_command(self, command_id: str, result: str, success: bool) -> bool:
        """Acknowledge a command has been processed."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-pull",
                params={"action": "ack_command"},
                headers=self.headers,
                json={
                    "commandId": command_id,
                    "result": result,
                    "success": success
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to acknowledge command: {e}")
            return False

    async def send_heartbeat(self) -> bool:
        """Send a heartbeat to indicate worker is alive."""
        try:
            response = await self.client.get(
                f"{self.base_url}/worker-pull",
                params={"action": "heartbeat"},
                headers=self.headers
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to send heartbeat: {e}")
            return False

    async def push_message(self, channel_id: str, message_data: dict) -> bool:
        """Push a new message to the queue."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-push",
                headers=self.headers,
                json={
                    "action": "push_message",
                    "data": {
                        "channel_id": channel_id,
                        **message_data
                    }
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to push message: {e}")
            return False

    async def mark_sent(self, message_id: str) -> bool:
        """Mark a message as successfully sent."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-push",
                headers=self.headers,
                json={
                    "action": "mark_sent",
                    "data": {"message_id": message_id}
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to mark message as sent: {e}")
            return False

    async def mark_failed(self, message_id: str, error: str) -> bool:
        """Mark a message as failed with error message."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-push",
                headers=self.headers,
                json={
                    "action": "mark_failed",
                    "data": {"message_id": message_id, "error_message": error}
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to mark message as failed: {e}")
            return False

    async def set_channel_cursor(self, channel_id: str, fingerprint: str, last_message_at: Optional[str] = None) -> bool:
        """Update a channel's last seen message fingerprint without enqueueing messages."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-push",
                headers=self.headers,
                json={
                    "action": "set_channel_cursor",
                    "data": {
                        "channel_id": channel_id,
                        "last_message_fingerprint": fingerprint,
                        "last_message_at": last_message_at,
                    },
                },
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to set channel cursor: {e}")
            return False

    async def update_connection_status(self, service: str, status: str, error: Optional[str] = None) -> bool:
        """Update connection status for a service."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-push",
                headers=self.headers,
                json={
                    "action": "update_connection_status",
                    "data": {
                        "service": service,
                        "status": status,
                        "error_message": error
                    }
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to update connection status: {e}")
            return False

    async def log(self, level: str, message: str, channel_name: Optional[str] = None, details: Optional[str] = None) -> bool:
        """Send a log entry to the backend."""
        try:
            response = await self.client.post(
                f"{self.base_url}/worker-push",
                headers=self.headers,
                json={
                    "action": "log",
                    "data": {
                        "level": level,
                        "message": message,
                        "channel_name": channel_name,
                        "details": details
                    }
                }
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Failed to send log: {e}")
            return False

    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()


# ============================================================================
class ChannelTab:
    """Manages a single browser tab watching one Discord channel."""

    # Direct Telegram sender reference (set by DiscordWatcher for fast sending)
    direct_telegram_sender = None

    # JavaScript to inject for real-time message detection
    OBSERVER_SCRIPT = """
    (function() {
        // Persistent state so periodic re-injection can reattach safely.
        const state = window.__discordObserverState || (window.__discordObserverState = {
            channelKey: null,
            seenMessages: new Set(),
            baselineSnowflake: 0n,
            baselineLocked: false,
            warmupUntil: Date.now() + 4000,
            startupAtMs: Date.now(),
            lastDomChangeAt: Date.now(),
            quietPeriodMs: 2500,
            maxPrimingMs: 12000,
        });

        const channelKey = location.pathname;
        if (state.channelKey !== channelKey) {
            state.channelKey = channelKey;
            state.seenMessages = new Set();
            state.baselineSnowflake = 0n;
            state.baselineLocked = false;
            state.warmupUntil = Date.now() + 4000;
            state.startupAtMs = Date.now();
            state.lastDomChangeAt = Date.now();
            state.maxPrimingMs = 12000;
            console.log('[Observer] Channel changed, state reset:', channelKey);
        }

        console.log('[Observer] Script loaded. startupAtMs=', state.startupAtMs);

        function parseSnowflakeFromMessageId(id) {
            if (!id) return null;
            const matches = id.match(/(\\d{16,20})/g);
            if (!matches || matches.length === 0) return null;
            const token = matches[matches.length - 1];
            try {
                return BigInt(token);
            } catch {
                return null;
            }
        }

        function isDiscordAttachmentUrl(url) {
            if (!url) return false;
            return /https?:\\/\\/(cdn\\.discordapp\\.com|media\\.discordapp\\.net)\\/(attachments|ephemeral-attachments)\\//.test(url);
        }

        function getMessageNodes(root = document) {
            return root.querySelectorAll('[id^="chat-messages-"], [data-list-item-id^="chat-messages"]');
        }

        function noteSeenMessageElement(element) {
            const id = element?.id || element?.getAttribute?.('data-list-item-id');
            if (!id) return;
            state.seenMessages.add(id);
            const snowflake = parseSnowflakeFromMessageId(id);
            if (snowflake !== null && snowflake > state.baselineSnowflake) {
                state.baselineSnowflake = snowflake;
            }
            state.lastDomChangeAt = Date.now();
        }

        function primeBaselineFromExistingDom() {
            const messages = getMessageNodes();
            messages.forEach(noteSeenMessageElement);
            console.log('[Observer] Priming baseline with', messages.length, 'nodes', state.baselineSnowflake > 0n ? `(baseline=${state.baselineSnowflake.toString()})` : '(no snowflake parsed)');
        }

        function maybeLockBaseline() {
            if (state.baselineLocked) return;
            const quietFor = Date.now() - state.lastDomChangeAt;
            const primingFor = Date.now() - state.startupAtMs;

            if (quietFor >= state.quietPeriodMs && state.baselineSnowflake > 0n) {
                state.baselineLocked = true;
                console.log('[Observer] Baseline locked:', state.baselineSnowflake.toString(), `(quiet ${quietFor}ms)`);
                return;
            }

            if (primingFor >= state.maxPrimingMs) {
                state.baselineLocked = true;
                console.log('[Observer] Baseline force-locked after', primingFor + 'ms', state.baselineSnowflake > 0n ? `(baseline=${state.baselineSnowflake.toString()})` : '(baseline=0, will forward all new)');
                return;
            }

            if (quietFor >= state.quietPeriodMs && primingFor >= 8000) {
                state.baselineLocked = true;
                console.log('[Observer] Baseline locked (empty channel mode) after', primingFor + 'ms - will forward all new messages');
            }
        }

        function extractMessage(element) {
            const id = element.id || element.getAttribute('data-list-item-id');
            if (!id || state.seenMessages.has(id)) return null;
            if (!state.baselineLocked) {
                noteSeenMessageElement(element);
                maybeLockBaseline();
                return null;
            }

            state.seenMessages.add(id);

            const timeEl = element.querySelector?.('time[datetime]');
            if (timeEl) {
                const dt = timeEl.getAttribute('datetime');
                if (dt) {
                    const ts = Date.parse(dt);
                    if (!Number.isNaN(ts)) {
                        if (ts < (state.startupAtMs - 15000)) {
                            return null;
                        }
                    }
                }
            }

            const snowflake = parseSnowflakeFromMessageId(id);
            if (snowflake !== null && snowflake <= state.baselineSnowflake) {
                return null;
            }
            if (snowflake !== null && snowflake > state.baselineSnowflake) {
                state.baselineSnowflake = snowflake;
            }

            if (Date.now() < state.warmupUntil) {
                console.log('[Observer] Skipping warmup message:', id);
                return null;
            }

            let author = 'Unknown';
            const authorSelectors = [
                '[class*="username-"]',
                'h3 span[class*="username"]',
                'span[class*="headerText-"] span',
                '[class*="headerText-"] [class*="username"]',
            ];
            for (const sel of authorSelectors) {
                const el = element.querySelector(sel);
                if (el && el.innerText && el.innerText.trim()) {
                    author = el.innerText.trim().replace(/[\\u{1F300}-\\u{1F9FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{1F600}-\\u{1F64F}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{1FA00}-\\u{1FA6F}\\u{1FA70}-\\u{1FAFF}\\u{2300}-\\u{23FF}\\u{FE00}-\\u{FE0F}\\u{200D}]/gu, '').trim();
                    break;
                }
            }

            let content = '';
            const contentSelectors = [
                '[id^="message-content-"]',
                '[class*="messageContent-"]',
            ];
            for (const sel of contentSelectors) {
                const el = element.querySelector(sel);
                if (el && el.innerText && el.innerText.trim()) {
                    const isInReplyPreview = el.closest('[class*="repliedMessage"]') ||
                                              el.closest('[class*="repliedTextPreview"]') ||
                                              el.closest('[class*="repliedTextContent"]') ||
                                              el.closest('[class*="replyBar"]') ||
                                              el.closest('[class*="clickable-"][class*="message-"]');
                    if (isInReplyPreview) {
                        continue;
                    }
                    content = el.innerText.trim();
                    break;
                }
            }

            const hasReplyPreview = element.querySelector('[class*="repliedMessage"]') ||
                                    element.querySelector('[class*="repliedTextPreview"]');
            if (hasReplyPreview && !content) {
                return null;
            }

            const attachments = [];
            element.querySelectorAll('a[href]').forEach(a => {
                const url = a.href;
                if (isDiscordAttachmentUrl(url)) attachments.push(url);
            });
            element.querySelectorAll('img[src]').forEach(img => {
                const url = img.src;
                if (isDiscordAttachmentUrl(url) && !attachments.includes(url)) attachments.push(url);
            });

            if (!content && attachments.length === 0) return null;

            return {
                message_id: id,
                author: author,
                content: content,
                attachments: attachments,
                timestamp: new Date().toISOString()
            };
        }

        function processNewMessages(nodes) {
            nodes.forEach(node => {
                if (node.nodeType !== 1) return;

                const isMessage = node.id?.startsWith('chat-messages-') ||
                                  node.getAttribute?.('data-list-item-id')?.startsWith('chat-messages');

                if (isMessage) {
                    if (!state.baselineLocked) {
                        noteSeenMessageElement(node);
                        maybeLockBaseline();
                        return;
                    }
                    const msg = extractMessage(node);
                    if (msg) {
                        console.log('[Observer] New message detected:', msg.author, msg.content?.substring(0, 50));
                        window.__onNewMessage(JSON.stringify(msg));
                    }
                }

                if (node.querySelectorAll) {
                    const childMessages = node.querySelectorAll('[id^="chat-messages-"], [data-list-item-id^="chat-messages"]');
                    childMessages.forEach(child => {
                        if (!state.baselineLocked) {
                            noteSeenMessageElement(child);
                            maybeLockBaseline();
                            return;
                        }
                        const msg = extractMessage(child);
                        if (msg) {
                            console.log('[Observer] New message detected (child):', msg.author);
                            window.__onNewMessage(JSON.stringify(msg));
                        }
                    });
                }
            });
        }

        function setupObserver() {
            state.containerRetries = state.containerRetries || 0;
            const maxContainerRetries = 30;

            const containerSelectors = [
                '[class*="messagesWrapper-"]',
                '[class*="scrollerInner-"]',
                '[class*="scroller-"][class*="content-"]',
                '[data-list-id="chat-messages"]',
                '[class*="chatContent-"]',
                'ol[class*="scrollerInner-"]',
                '[role="log"]',
                'main [class*="chat-"]',
                '[class*="messageListItem-"]',
                '[id^="chat-messages-"]',
                '[class*="message-"][class*="container-"]',
                'main'
            ];

            let container = null;
            for (const sel of containerSelectors) {
                container = document.querySelector(sel);
                if (container) {
                    console.log('[Observer] Found container with selector:', sel);
                    state.containerRetries = 0;
                    break;
                }
            }

            if (!container) {
                state.containerRetries++;
                if (state.containerRetries >= maxContainerRetries) {
                    console.log('[Observer] FAILED to find container after', maxContainerRetries, 'attempts. Attaching to document.body as fallback.');
                    container = document.body;
                } else {
                    if (state.containerRetries % 5 === 0) {
                        console.log('[Observer] No container found, retrying...', state.containerRetries + '/' + maxContainerRetries);
                    }
                    setTimeout(setupObserver, 1000);
                    return;
                }
            }

            try {
                if (window.__discordMutationObserver) {
                    window.__discordMutationObserver.disconnect();
                }
            } catch {}

            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        processNewMessages(mutation.addedNodes);
                        if (!state.baselineLocked) {
                            state.lastDomChangeAt = Date.now();
                        }
                    }
                }
            });

            observer.observe(container, {
                childList: true,
                subtree: true
            });

            window.__discordMutationObserver = observer;

            console.log('[Observer] MutationObserver active on', container.className);
        }

        function scrollToBottom() {
            const scroller = document.querySelector('[class*="messagesWrapper-"]');
            if (scroller) {
                scroller.scrollTop = scroller.scrollHeight;
            }
        }

        function waitForInitialMessages(attempt = 0) {
            const messages = getMessageNodes();
            if (messages.length > 0 || attempt >= 30) {
                if (attempt >= 30) {
                    console.log('[Observer] No messages found after wait; starting observer anyway');
                }
                setupObserver();
                primeBaselineFromExistingDom();
                startBaselineLockTimer();
                return;
            }
            setTimeout(() => waitForInitialMessages(attempt + 1), 200);
        }

        function startBaselineLockTimer() {
            const primingInterval = setInterval(() => {
                if (state.baselineLocked) {
                    console.log('[Observer] Priming complete, baseline locked');
                    clearInterval(primingInterval);
                    return;
                }
                scrollToBottom();
                primeBaselineFromExistingDom();
                maybeLockBaseline();

                const primingFor = Date.now() - state.startupAtMs;
                if (primingFor > 5000 && primingFor % 2000 < 500) {
                    console.log('[Observer] Still priming... elapsed:', primingFor + 'ms', 'baseline:', state.baselineSnowflake > 0n ? state.baselineSnowflake.toString() : '0');
                }
            }, 500);
        }

        setTimeout(() => {
            scrollToBottom();
            setTimeout(() => {
                waitForInitialMessages();
            }, 800);
        }, 1000);
    })();
    """

    def __init__(self, channel: dict, context: BrowserContext, api: APIClient, on_message_callback, get_banned_authors_func, telegram_sender=None):
        self.channel = channel
        self.context = context
        self.api = api
        self.on_message_callback = on_message_callback
        self.get_banned_authors = get_banned_authors_func
        self.telegram_sender = telegram_sender
        self.page: Optional[Page] = None
        self.running = False
        url_parts = channel['url'].rstrip('/').split('/')
        self.channel_id = url_parts[-1] if url_parts else channel['id']
        self.channel_name = channel['name']
        self.channel_url = channel['url']

    def _generate_fingerprint(self, message_id: str) -> str:
        """Generate a unique fingerprint for a message."""
        content = f"{self.channel_id}:{message_id}"
        return hashlib.sha256(content.encode()).hexdigest()[:32]

    async def _handle_new_message(self, message_json: str):
        """Callback when MutationObserver detects a new message."""
        try:
            msg = json.loads(message_json)
            author = (msg.get('author') or '').strip()

            banned = self.get_banned_authors()
            if banned:
                banned_lower = [a.lower() for a in banned]
                if author.lower() in banned_lower:
                    logger.info(f"[{self.channel_name}] Skipping message from banned author: {author}")
                    return

            fingerprint = self._generate_fingerprint(msg['message_id'])

            raw_text = (msg.get('content') or '').strip()
            if author and raw_text:
                raw_text = re.sub(rf'^\s*{re.escape(author)}\s*:\s*', '', raw_text).strip()

            logger.info(f"[{self.channel_name}] New message from {author}: {raw_text[:50] if raw_text else '[attachment]'}...")

            if self.telegram_sender and self.telegram_sender.running:
                try:
                    await self.telegram_sender.send_direct(
                        text=raw_text,
                        channel_name=self.channel_name,
                        channel_id=self.channel_id,
                        attachments=msg.get('attachments', [])
                    )
                    logger.info(f"[{self.channel_name}] ⚡ FAST sent to Telegram")
                except Exception as e:
                    logger.error(f"[{self.channel_name}] Fast send failed, falling back to queue: {e}")
                    await self.api.push_message(self.channel_id, {
                        'fingerprint': fingerprint,
                        'discord_message_id': msg['message_id'],
                        'author_name': author,
                        'message_text': raw_text,
                        'attachment_urls': msg['attachments']
                    })
            else:
                success = await self.api.push_message(self.channel_id, {
                    'fingerprint': fingerprint,
                    'discord_message_id': msg['message_id'],
                    'author_name': author,
                    'message_text': raw_text,
                    'attachment_urls': msg['attachments']
                })

                if success:
                    await self.api.log('success', "Queued message", self.channel_name, f"From: {author} | Content: {raw_text[:80] if raw_text else '[attachment]'}")

            if self.on_message_callback:
                await self.on_message_callback(self.channel_id, msg)

            await self._detect_and_queue_ca(raw_text, author)

        except Exception as e:
            logger.error(f"[{self.channel_name}] Error handling message: {e}")

    async def _detect_and_queue_ca(self, text: str, author: str):
        """Detect contract addresses in message and queue for trading."""
        if not text:
            return

        SOLANA_CA_REGEX = r'[1-9A-HJ-NP-Za-km-z]{32,44}'
        EVM_CA_REGEX = r'0x[a-fA-F0-9]{40}'

        SKIP_ADDRESSES = {
            'So11111111111111111111111111111111111111112',
            '11111111111111111111111111111111',
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        }

        CHANNEL_CATEGORIES = {
            '1240062418164645888': 'memecoin-chat',
            '1432404864008327200': 'under-100k',
            '1250836631649386496': 'memecoin-alpha',
        }
        channel_category = CHANNEL_CATEGORIES.get(self.channel_id, 'other')

        detected_cas = []

        for match in re.findall(SOLANA_CA_REGEX, text):
            if match not in SKIP_ADDRESSES and len(match) >= 32:
                detected_cas.append({'address': match, 'chain': 'solana'})

        for match in re.findall(EVM_CA_REGEX, text):
            detected_cas.append({'address': match.lower(), 'chain': 'base'})

        for ca in detected_cas:
            try:
                await self.api.queue_trade_ca(
                    token_address=ca['address'],
                    chain=ca['chain'],
                    channel_id=self.channel_id,
                    channel_name=self.channel_name,
                    channel_category=channel_category,
                    author=author,
                    message_preview=text[:200]
                )
                logger.info(f"[{self.channel_name}] 🎯 CA detected ({ca['chain']}): {ca['address'][:15]}... -> {channel_category}")
            except Exception as e:
                logger.error(f"[{self.channel_name}] Failed to queue CA: {e}")

    async def start(self):
        """Open tab and start watching the channel."""
        try:
            self.page = await self.context.new_page()
            self.running = True

            def _on_console(msg):
                try:
                    logger.info(f"[{self.channel_name}] [page] {msg.type}: {msg.text}")
                except Exception:
                    pass

            try:
                self.page.on("console", _on_console)
            except Exception:
                pass

            await self.page.expose_function('__onNewMessage', self._handle_new_message)

            logger.info(f"[{self.channel_name}] Opening channel tab...")
            max_nav_retries = 3
            for nav_attempt in range(max_nav_retries):
                try:
                    await self.page.goto(self.channel_url, wait_until='domcontentloaded', timeout=60000)
                    break
                except Exception as nav_err:
                    if nav_attempt < max_nav_retries - 1:
                        logger.warning(f"[{self.channel_name}] Navigation timeout, retrying ({nav_attempt + 1}/{max_nav_retries})...")
                        await asyncio.sleep(5)
                    else:
                        raise nav_err

            try:
                await self.page.wait_for_selector('[class*="messagesWrapper-"], [class*="chatContent-"], [data-list-id="chat-messages"]', timeout=15000)
            except:
                logger.warning(f"[{self.channel_name}] Message container not found via selector, waiting for page to settle...")
                await asyncio.sleep(5)

            await self.page.evaluate(self.OBSERVER_SCRIPT)

            try:
                await asyncio.sleep(3)
                obs_state = await self.page.evaluate("""() => {
                  const s = window.__discordObserverState;
                  if (!s) return null;
                  return {
                    channelKey: s.channelKey,
                    baselineLocked: s.baselineLocked,
                    baselineSnowflake: (s.baselineSnowflake && s.baselineSnowflake.toString) ? s.baselineSnowflake.toString() : null,
                    startupAtMs: s.startupAtMs,
                    maxPrimingMs: s.maxPrimingMs,
                    seenCount: s.seenMessages ? s.seenMessages.size : null,
                  };
                }""")
                logger.info(f"[{self.channel_name}] Observer state: {obs_state}")
                try:
                    await self.api.log('info', 'Observer state', self.channel_name, json.dumps(obs_state))
                except Exception:
                    pass
            except Exception as e:
                logger.debug(f"[{self.channel_name}] Could not read observer state: {e}")

            await self.api.log('success', f"Channel tab opened with real-time observer", self.channel_name)
            logger.info(f"[{self.channel_name}] MutationObserver active - watching for new messages")

            while self.running:
                await asyncio.sleep(5)
                try:
                    await self.page.evaluate(self.OBSERVER_SCRIPT)
                except:
                    pass

        except Exception as e:
            logger.error(f"[{self.channel_name}] Tab error: {e}")
            await self.api.log('error', f"Channel tab error: {e}", self.channel_name)

    async def stop(self):
        """Close the tab."""
        self.running = False
        if self.page:
            try:
                await self.page.close()
            except:
                pass
        logger.info(f"[{self.channel_name}] Tab closed")


# ============================================================================
class DiscordWatcher:
    """Watches Discord channels using parallel tabs with MutationObserver."""

    def __init__(self, config: Config, api: APIClient, telegram_sender=None):
        self.config = config
        self.api = api
        self.telegram_sender = telegram_sender
        self.context: Optional[BrowserContext] = None
        self.tabs: dict[str, ChannelTab] = {}
        self.running = False
        self.message_queue = asyncio.Queue()
        self.banned_authors: list[str] = []
        self._keepalive_page: Optional[Page] = None

    async def start(self):
        """Start the browser and login to Discord."""
        logger.info("Starting Discord watcher (MutationObserver mode)...")

        playwright = await async_playwright().start()

        self.context = await playwright.chromium.launch_persistent_context(
            self.config.browser_profile_path,
            headless=self.config.headless,
            viewport={'width': 1280, 'height': 800},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )

        self.running = True

        page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        await page.goto('https://discord.com/channels/@me')
        await asyncio.sleep(3)

        if 'login' in page.url.lower():
            logger.warning("Not logged in to Discord. Please login manually...")
            await self.api.update_connection_status('discord', 'disconnected', 'Login required')
            await self.api.log('warn', 'Discord login required - please login in the browser window')

            for _ in range(60):
                await asyncio.sleep(5)
                if 'login' not in page.url.lower():
                    logger.info("Discord login successful!")
                    break
            else:
                raise Exception("Discord login timeout - please run in non-headless mode to login")

        await page.goto('about:blank')
        self._keepalive_page = page
        logger.info("Browser context initialized with keepalive page")

        await self.api.update_connection_status('discord', 'connected')
        await self.api.log('info', 'Discord watcher connected (real-time MutationObserver mode)')
        logger.info("Discord watcher ready!")

    async def _on_message(self, channel_id: str, message: dict):
        """Callback when any tab detects a new message."""
        await self.message_queue.put((channel_id, message))

    async def _sync_tabs(self):
        """Sync tabs with enabled channels from database."""
        channels = await self.api.get_channels()
        enabled_channels = {c['id']: c for c in channels if c.get('enabled')}

        to_remove = [cid for cid in self.tabs if cid not in enabled_channels]
        for cid in to_remove:
            logger.info(f"Closing tab for disabled channel: {self.tabs[cid].channel_name}")
            await self.tabs[cid].stop()
            del self.tabs[cid]

        new_channels = [(cid, channel) for cid, channel in enabled_channels.items() if cid not in self.tabs]
        for i, (cid, channel) in enumerate(new_channels):
            logger.info(f"Opening tab for new channel: {channel['name']}")
            tab = ChannelTab(channel, self.context, self.api, self._on_message, self._get_banned_authors, self.telegram_sender)
            self.tabs[cid] = tab
            asyncio.create_task(self._start_tab_with_delay(tab, i * 0.5))

        return len(self.tabs)

    async def _start_tab_with_delay(self, tab: ChannelTab, delay: float):
        """Start a tab after a delay to avoid overwhelming the browser."""
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            await tab.start()
        except Exception as e:
            logger.error(f"[{tab.channel_name}] Failed to start tab: {e}")

    async def _refresh_banned_authors(self):
        """Fetch latest banned authors blacklist."""
        banned = await self.api.get_banned_authors()
        if banned != self.banned_authors:
            logger.info(f"Banned authors updated: {banned if banned else '(none)'}")
            await self.api.log('info', f"Author blacklist updated: {len(banned)} users" if banned else "Author blacklist cleared")
        self.banned_authors = banned

    def _get_banned_authors(self) -> list[str]:
        """Return current banned authors list (used by ChannelTab)."""
        return self.banned_authors

    async def watch_channels(self):
        """Main loop to manage channel tabs."""
        await self._refresh_banned_authors()

        count = await self._sync_tabs()
        await self.api.log('info', f'Started watching {count} channels with real-time detection')

        while self.running:
            try:
                await asyncio.sleep(self.config.channel_refresh_interval)
                await self._refresh_banned_authors()
                count = await self._sync_tabs()
                await self.api.update_connection_status('discord', 'connected')
                logger.debug(f"Channel sync complete: {count} tabs active")
            except Exception as e:
                logger.error(f"Error in channel sync: {e}")
                await self.api.log('error', f"Channel sync error: {e}")

    async def stop(self):
        """Stop the watcher and close all tabs."""
        self.running = False

        for tab in self.tabs.values():
            await tab.stop()
        self.tabs.clear()

        if self._keepalive_page:
            try:
                await self._keepalive_page.close()
            except Exception:
                pass
            self._keepalive_page = None

        if self.context:
            await self.context.close()

        logger.info("Discord watcher stopped")


# ============================================================================
class TelegramSender:
    """Sends messages to Telegram using Telethon (MTProto)."""

    def __init__(self, config: Config, api: APIClient):
        self.config = config
        self.api = api
        self.client: Optional[TelegramClient] = None
        self.running = False
        self.destination = None

    async def start(self):
        """Start the Telegram client and authenticate."""
        logger.info("Starting Telegram sender...")

        self.client = TelegramClient(
            self.config.telegram_session_name,
            self.config.telegram_api_id,
            self.config.telegram_api_hash
        )

        await self.client.start()

        me = await self.client.get_me()
        logger.info(f"Logged in to Telegram as: {me.first_name} (@{me.username})")

        await self.api.update_connection_status('telegram', 'connected')
        await self.api.log('info', f'Telegram connected as {me.first_name}')

        self.running = True
        logger.info("Telegram sender ready!")

    async def _get_destination(self):
        """Get the Telegram destination from config."""
        config = await self.api.get_telegram_config()

        if not config:
            return None

        identifier = config.get('identifier')
        dest_type = config.get('destination_type')
        use_topics = config.get('use_topics', False)

        try:
            if identifier.startswith('@'):
                entity = await self.client.get_entity(identifier)
            elif identifier.startswith('-100'):
                entity = await self.client.get_entity(int(identifier))
            else:
                entity = await self.client.get_entity(int(identifier))

            return {
                'entity': entity,
                'use_topics': use_topics,
                'config': config
            }
        except Exception as e:
            logger.error(f"Failed to resolve Telegram destination: {e}")
            return None

    async def send_direct(self, text: str, channel_name: str, channel_id: str, attachments: list = None):
        """Send a message directly to Telegram (fast path, no queue)."""
        if not self.running or not self.client:
            raise Exception("Telegram sender not running")

        if not self.destination:
            self.destination = await self._get_destination()

        if not self.destination:
            raise Exception("No Telegram destination configured")

        dest = self.destination

        reply_to = None
        if dest['use_topics']:
            channels = await self.api.get_channels()
            channel = next((c for c in channels if c['id'] == channel_id), None)
            if channel and channel.get('telegram_topic_id'):
                reply_to = int(channel['telegram_topic_id'])

        if text and text.strip():
            await self.client.send_message(
                dest['entity'],
                text.strip(),
                reply_to=reply_to,
                parse_mode=None
            )

        if attachments:
            for url in attachments[:3]:
                try:
                    await self.client.send_file(
                        dest['entity'],
                        url,
                        reply_to=reply_to
                    )
                except Exception as e:
                    logger.warning(f"Failed to send attachment: {e}")

    async def _format_message(self, msg: dict, channel_name: str) -> str:
        """Format a message for Telegram - text only, no username."""
        return (msg.get('message_text') or '').strip()

    async def send_pending_messages(self):
        """Main loop to send pending messages."""
        while self.running:
            try:
                messages = await self.api.get_pending_messages()

                if not messages:
                    await asyncio.sleep(0.3)
                    continue

                dest = await self._get_destination()
                if not dest:
                    logger.warning("No Telegram destination configured")
                    await asyncio.sleep(10)
                    continue

                channels = await self.api.get_channels()

                for msg in messages:
                    try:
                        channel = next((c for c in channels if c['id'] == msg.get('channel_id')), None)
                        channel_name = channel['name'] if channel else 'Unknown'

                        attachments = msg.get('attachment_urls', []) or []
                        has_text = bool((msg.get('message_text') or '').strip())
                        if not has_text and not attachments:
                            await self.api.mark_failed(msg['id'], 'Empty message (no text/attachments)')
                            await self.api.log('warning', 'Skipped empty message (no text/attachments)', channel_name)
                            continue

                        text = await self._format_message(msg, channel_name)

                        reply_to = None
                        if dest['use_topics'] and channel and channel.get('telegram_topic_id'):
                            reply_to = int(channel['telegram_topic_id'])

                        await self.client.send_message(
                            dest['entity'],
                            text,
                            reply_to=reply_to,
                            parse_mode=None
                        )

                        if attachments and channel and channel.get('mirror_attachments', True):
                            for url in attachments[:5]:
                                try:
                                    await self.client.send_file(
                                        dest['entity'],
                                        url,
                                        reply_to=reply_to
                                    )
                                except Exception as e:
                                    logger.warning(f"Failed to send attachment: {e}")

                        await self.api.mark_sent(msg['id'])
                        logger.info(f"Sent message to Telegram: {msg['id'][:8]}...")
                        await self.api.log('info', f"Sent message from {msg['author_name']}", channel_name)

                    except Exception as e:
                        logger.error(f"Failed to send message {msg['id']}: {e}")
                        await self.api.mark_failed(msg['id'], str(e))
                        await self.api.log('error', f"Failed to send message: {e}", channel_name if 'channel_name' in dir() else None)

                await self.api.update_connection_status('telegram', 'connected')

            except Exception as e:
                logger.error(f"Error in send loop: {e}")
                await self.api.update_connection_status('telegram', 'error', str(e))

            await asyncio.sleep(0.2)

    async def stop(self):
        """Stop the sender and disconnect."""
        self.running = False
        if self.client:
            await self.client.disconnect()
        logger.info("Telegram sender stopped")


# ============================================================================
class DiscordTelegramRelay:
    """Main application coordinating Discord watching and Telegram sending."""

    def __init__(self):
        self.config = Config.from_env()
        self.api = APIClient(self.config)
        self.telegram_sender = TelegramSender(self.config, self.api)
        self.discord_watcher = DiscordWatcher(self.config, self.api, self.telegram_sender)
        self.running = False

    async def start(self):
        """Start the relay."""
        logger.info("=" * 60)
        logger.info("Discord to Telegram Relay Starting (Real-Time Mode)")
        logger.info("=" * 60)

        self.running = True

        for sig in (signal.SIGINT, signal.SIGTERM):
            asyncio.get_event_loop().add_signal_handler(
                sig, lambda: asyncio.create_task(self.stop())
            )

        try:
            await asyncio.gather(
                self.discord_watcher.start(),
                self.telegram_sender.start()
            )

            await self.api.log('info', 'Discord to Telegram relay started (real-time mode)')

            tasks = [
                self.discord_watcher.watch_channels(),
                self.telegram_sender.send_pending_messages(),
                self._heartbeat()
            ]

            logger.info("📡 Relay-only mode (trading handled by separate service)")

            await asyncio.gather(*tasks)

        except Exception as e:
            logger.error(f"Relay error: {e}")
            await self.api.log('error', f'Relay error: {e}')
            raise

    async def _heartbeat(self):
        """Send periodic heartbeats and check for commands."""
        while self.running:
            try:
                await self.api.send_heartbeat()
                await self.api.update_connection_status('discord', 'connected')
                await self.api.update_connection_status('telegram', 'connected')

                commands = await self.api.get_pending_commands()
                for cmd in commands:
                    await self._process_command(cmd)

            except Exception as e:
                logger.debug(f"Heartbeat error: {e}")
            await asyncio.sleep(10)

    async def _process_command(self, cmd: dict):
        """Process a command from the dashboard."""
        command = cmd.get('command')
        command_id = cmd.get('id')

        logger.info(f"Received command: {command}")
        await self.api.log('info', f'Processing command: {command}')

        try:
            if command == 'stop':
                await self.api.ack_command(command_id, 'Stopping worker...', True)
                await self.stop()

            elif command == 'restart':
                await self.api.ack_command(command_id, 'Restarting worker...', True)
                await self.stop()

            elif command == 'sync_channels':
                await self.discord_watcher._sync_tabs()
                await self.api.ack_command(command_id, 'Channels synced', True)

            elif command == 'start':
                await self.api.ack_command(command_id, 'Worker already running', True)

            else:
                await self.api.ack_command(command_id, f'Unknown command: {command}', False)

        except Exception as e:
            logger.error(f"Error processing command {command}: {e}")
            await self.api.ack_command(command_id, f'Error: {e}', False)

    async def stop(self):
        """Stop the relay gracefully."""
        logger.info("Shutting down relay...")
        self.running = False

        await asyncio.gather(
            self.discord_watcher.stop(),
            self.telegram_sender.stop()
        )

        await self.api.update_connection_status('discord', 'disconnected')
        await self.api.update_connection_status('telegram', 'disconnected')
        await self.api.log('info', 'Discord to Telegram relay stopped')
        await self.api.close()

        logger.info("Relay stopped")


# ============================================================================
async def main():
    """Main entry point."""
    relay = DiscordTelegramRelay()
    await relay.start()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1)
