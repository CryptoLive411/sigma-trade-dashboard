# Discord Relay Worker (Python)

Real-time Discord message relay to Telegram with automatic CA detection and trading via Jupiter.

## Features

- **Real-time Discord Monitoring**: Uses Playwright + MutationObserver for instant message detection (<100ms latency)
- **Telegram Relay**: Sends messages to Telegram via MTProto (Telethon)
- **CA Detection**: Automatically detects Solana and Base contract addresses
- **Jupiter Trading**: Executes trades directly via Jupiter V6 API
- **Position Management**: Auto-sell with TP/SL, trailing stops, and time-based exits

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Discord Relay Worker                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Discord    │───▶│  CA Detect   │───▶│   Telegram   │  │
│  │   Watcher    │    │   + Queue    │    │   Sender     │  │
│  │ (Playwright) │    │              │    │  (Telethon)  │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                   │                               │
│         │                   ▼                               │
│         │           ┌──────────────┐                        │
│         │           │   Jupiter    │                        │
│         └──────────▶│   Trader     │                        │
│                     │  (Solana)    │                        │
│                     └──────────────┘                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Setup

### 1. Install Dependencies

```bash
cd worker
pip install -r requirements.txt
playwright install chromium
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. First-Time Discord Login

Run with `HEADLESS=false` to login manually:

```bash
HEADLESS=false python discord_telegram_relay.py
```

Login to Discord in the browser window. Your session will be saved to `./discord_profile`.

### 4. Run the Worker

```bash
python discord_telegram_relay.py
```

## Channel Categories

The worker automatically categorizes channels for trading:

| Channel Pattern | Priority | Allocation | Stop Loss | TP1 | TP2 |
|----------------|----------|------------|-----------|-----|-----|
| memecoin-alpha | High | 0.5 SOL | -25% | 100% | 200% |
| memecoin-chat | Low | 0.1 SOL | -15% | 50% | 100% |
| under-100k | Low | 0.1 SOL | -20% | 75% | 150% |
| other | Medium | 0.25 SOL | -30% | 100% | 200% |

## Trading Features

### Auto-Sell Triggers

1. **Stop Loss**: Sells 100% when PnL drops below threshold
2. **Trailing Stop**: Sells 100% when price drops X% from highest
3. **Take Profit 1**: Sells 50% at first target
4. **Take Profit 2**: Sells remaining at second target
5. **Time-Based**: Sells 100% after configured time (for volatile channels)

### Position Monitoring

The worker monitors positions every 5 seconds and:
- Updates current price via Jupiter Price API
- Tracks highest price for trailing stops
- Triggers auto-sells when conditions are met

## Files

- `discord_telegram_relay.py` - Main relay worker (Discord → Telegram)
- `jupiter_trader.py` - Solana trading module via Jupiter
- `requirements.txt` - Python dependencies
- `.env.example` - Environment configuration template

## Integration with Node.js Server

This Python worker runs alongside the Node.js trading-bot-v2 server:

- **Node.js Server**: Handles web dashboard, API routes, Base chain trading
- **Python Worker**: Handles Discord scraping, Telegram relay, Solana trading

Both services communicate via Supabase for:
- Channel configuration
- Trade queue
- Position tracking
- Logs and status updates
