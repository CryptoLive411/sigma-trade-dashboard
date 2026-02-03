#!/usr/bin/env python3
"""
Jupiter Solana Trader Module
============================
Executes SOL <-> Token swaps via Jupiter Aggregator V6 API.
Includes Position Manager for auto-sell based on TP/SL thresholds.

Features:
- Channel-based allocation (memecoin-alpha: high, memecoin-chat/under-100k: low)
- Auto-sell with trailing stop loss
- Time-based auto-sell for volatile channels
- Stop loss and take profit triggers

Usage:
    from jupiter_trader import SolanaTrader

    trader = SolanaTrader(api_client, private_key)
    await trader.process_pending_trades()
"""

import asyncio
import base58
import base64
import json
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from dataclasses import dataclass, field

import httpx
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction
from solders import message
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed

logger = logging.getLogger('jupiter_trader')

# ============================================================================
JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote"
JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap"
JUPITER_PRICE_API = "https://api.jup.ag/price/v2"
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# RPC endpoints (with fallbacks)
RPC_ENDPOINTS = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/solana",
]

# Position monitoring interval
POSITION_CHECK_INTERVAL = 5  # seconds - faster for volatile tokens

# Channel priority configurations
CHANNEL_CONFIGS = {
    'memecoin-alpha': {
        'priority': 'high',
        'allocation_sol': 0.5,
        'stop_loss_pct': -25.0,
        'take_profit_1_pct': 100.0,
        'take_profit_2_pct': 200.0,
        'trailing_stop_enabled': True,
        'trailing_stop_pct': 15.0,
        'time_based_sell_enabled': False,
        'time_based_sell_minutes': None,
    },
    'memecoin-chat': {
        'priority': 'low',
        'allocation_sol': 0.1,
        'stop_loss_pct': -15.0,
        'take_profit_1_pct': 50.0,
        'take_profit_2_pct': 100.0,
        'trailing_stop_enabled': True,
        'trailing_stop_pct': 10.0,
        'time_based_sell_enabled': True,
        'time_based_sell_minutes': 30,
    },
    'under-100k': {
        'priority': 'low',
        'allocation_sol': 0.1,
        'stop_loss_pct': -20.0,
        'take_profit_1_pct': 75.0,
        'take_profit_2_pct': 150.0,
        'trailing_stop_enabled': True,
        'trailing_stop_pct': 12.0,
        'time_based_sell_enabled': True,
        'time_based_sell_minutes': 45,
    },
}

# ============================================================================
@dataclass
class TradeResult:
    """Result of a trade execution."""
    success: bool
    signature: Optional[str] = None
    error: Optional[str] = None
    expected_output: Optional[float] = None
    tokens_received: Optional[int] = None


@dataclass
class ChannelConfig:
    """Trading configuration for a specific channel."""
    priority: str = 'medium'
    allocation_sol: float = 0.25
    stop_loss_pct: float = -30.0
    take_profit_1_pct: float = 100.0
    take_profit_2_pct: float = 200.0
    trailing_stop_enabled: bool = False
    trailing_stop_pct: float = 15.0
    time_based_sell_enabled: bool = False
    time_based_sell_minutes: Optional[int] = None
    auto_sell_enabled: bool = True


def get_channel_config(channel_name: str) -> ChannelConfig:
    """Get trading config for a channel, matching by pattern."""
    channel_lower = channel_name.lower()

    for pattern, config in CHANNEL_CONFIGS.items():
        if pattern in channel_lower:
            return ChannelConfig(**config)

    # Default config for unknown channels
    return ChannelConfig()


# ============================================================================
class SolanaTrader:
    """
    Executes Solana token trades via Jupiter Aggregator.

    This class handles:
    - Wallet management from private key
    - Jupiter quote fetching
    - Swap transaction execution
    - Position monitoring with auto-sell triggers
    - Trade status updates via API client
    """

    def __init__(self, api_client, private_key: str, rpc_url: str = None):
        """
        Initialize the Solana trader.

        Args:
            api_client: APIClient instance for database updates
            private_key: Base58 or JSON array private key
            rpc_url: Optional custom RPC endpoint
        """
        self.api = api_client
        self.http = httpx.AsyncClient(timeout=30.0)
        self.rpc_url = rpc_url or RPC_ENDPOINTS[0]
        self.rpc = None
        self.keypair = self._load_keypair(private_key)
        self.running = True

        logger.info(f"🔑 Solana wallet loaded: {self.public_key}")

    def _load_keypair(self, private_key: str) -> Keypair:
        """Load keypair from various private key formats."""
        try:
            # Try base58 decode first
            decoded = base58.b58decode(private_key)
            return Keypair.from_bytes(decoded)
        except Exception:
            pass

        try:
            # Try JSON array format
            arr = json.loads(private_key)
            return Keypair.from_bytes(bytes(arr))
        except Exception:
            pass

        raise ValueError("Invalid private key format. Expected base58 or JSON array.")

    @property
    def public_key(self) -> str:
        """Get wallet public key as string."""
        return str(self.keypair.pubkey())

    async def connect_rpc(self):
        """Connect to Solana RPC with fallback endpoints."""
        for endpoint in RPC_ENDPOINTS:
            try:
                self.rpc = AsyncClient(endpoint)
                # Test connection
                await self.rpc.get_latest_blockhash()
                self.rpc_url = endpoint
                logger.info(f"✅ Connected to Solana RPC: {endpoint}")
                return
            except Exception as e:
                logger.warning(f"RPC {endpoint} failed: {e}")
                continue

        raise ConnectionError("Failed to connect to any Solana RPC endpoint")

    async def get_balance(self) -> float:
        """Get wallet SOL balance."""
        if not self.rpc:
            await self.connect_rpc()

        resp = await self.rpc.get_balance(self.keypair.pubkey())
        return resp.value / 1_000_000_000

    async def get_token_balance(self, mint_address: str) -> Optional[int]:
        """Get token balance for a specific mint."""
        if not self.rpc:
            await self.connect_rpc()

        try:
            token_accounts = await self.rpc.get_token_accounts_by_owner(
                self.keypair.pubkey(),
                {"mint": Pubkey.from_string(mint_address)}
            )

            if not token_accounts.value:
                return 0

            account_data = token_accounts.value[0].account.data
            # Parse token amount from account data (bytes 64-72 contain the amount)
            token_amount = int.from_bytes(account_data[64:72], 'little')
            return token_amount

        except Exception as e:
            logger.error(f"Failed to get token balance: {e}")
            return None

    async def get_quote(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int = 100,
        retries: int = 3
    ) -> Optional[dict]:
        """
        Get a swap quote from Jupiter with retry logic.

        Args:
            input_mint: Input token mint address
            output_mint: Output token mint address
            amount: Amount in smallest unit (lamports/token base units)
            slippage_bps: Slippage tolerance in basis points (100 = 1%)
            retries: Number of retry attempts

        Returns:
            Quote dict or None if failed
        """
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": str(slippage_bps),
            "onlyDirectRoutes": "false",
            "asLegacyTransaction": "false",
        }

        for attempt in range(retries):
            try:
                response = await self.http.get(JUPITER_QUOTE_API, params=params, timeout=10.0)

                if response.status_code == 400:
                    error_data = response.json()
                    error_msg = error_data.get('error', 'Unknown error')
                    logger.warning(f"Jupiter quote error: {error_msg}")
                    # No route found - token might have no liquidity
                    if 'No route found' in str(error_msg) or 'could not find' in str(error_msg).lower():
                        logger.error(f"No liquidity for token {output_mint[:8]}...")
                        return None

                response.raise_for_status()
                quote = response.json()

                if quote and quote.get('outAmount'):
                    return quote

            except Exception as e:
                logger.warning(f"Jupiter quote attempt {attempt + 1}/{retries} failed: {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(1)  # Wait before retry
                continue

        logger.error(f"Jupiter quote failed after {retries} attempts")
        return None

    async def get_token_price_sol(self, mint_address: str) -> Optional[float]:
        """Get token price in SOL using Jupiter price API."""
        try:
            params = {"ids": mint_address, "vsToken": SOL_MINT}
            response = await self.http.get(JUPITER_PRICE_API, params=params)
            response.raise_for_status()
            data = response.json()

            price_data = data.get("data", {}).get(mint_address)
            if price_data:
                return float(price_data.get("price", 0))
            return None

        except Exception as e:
            logger.debug(f"Price fetch failed for {mint_address[:8]}...: {e}")
            return None

    async def execute_swap(self, quote: dict) -> TradeResult:
        """
        Execute a swap transaction using Jupiter V6 API.

        Args:
            quote: Quote dict from get_quote()

        Returns:
            TradeResult with signature or error
        """
        try:
            if not self.rpc:
                await self.connect_rpc()

            # Get swap transaction from Jupiter
            swap_payload = {
                "quoteResponse": quote,
                "userPublicKey": self.public_key,
                "wrapUnwrapSOL": True,
                "dynamicComputeUnitLimit": True,
                "prioritizationFeeLamports": "auto",
            }

            logger.info(f"📤 Requesting swap transaction from Jupiter...")

            response = await self.http.post(
                JUPITER_SWAP_API,
                json=swap_payload,
                headers={"Content-Type": "application/json"},
                timeout=30.0
            )

            if response.status_code != 200:
                error_text = response.text
                logger.error(f"Jupiter swap API error: {response.status_code} - {error_text}")
                return TradeResult(success=False, error=f"Jupiter swap API error: {error_text[:100]}")

            swap_result = response.json()

            swap_tx = swap_result.get("swapTransaction")
            if not swap_tx:
                return TradeResult(success=False, error="No swap transaction returned from Jupiter")

            # Jupiter returns base64-encoded transaction
            logger.info(f"📝 Decoding and signing transaction...")
            raw_transaction = VersionedTransaction.from_bytes(base64.b64decode(swap_tx))

            # Sign the transaction message
            signature = self.keypair.sign_message(message.to_bytes_versioned(raw_transaction.message))

            # Create signed transaction
            signed_txn = VersionedTransaction.populate(raw_transaction.message, [signature])

            # Send transaction
            logger.info(f"📤 Sending transaction to Solana...")
            result = await self.rpc.send_raw_transaction(
                bytes(signed_txn),
                opts={"skip_preflight": True, "max_retries": 3}
            )

            tx_signature = str(result.value)
            logger.info(f"📤 TX sent: {tx_signature}")

            # Wait for confirmation with timeout
            try:
                await asyncio.wait_for(
                    self.rpc.confirm_transaction(tx_signature, commitment=Confirmed),
                    timeout=60.0
                )
                logger.info(f"✅ TX confirmed: {tx_signature}")
            except asyncio.TimeoutError:
                logger.warning(f"TX confirmation timeout, but tx was sent: {tx_signature}")

            return TradeResult(
                success=True,
                signature=tx_signature,
                expected_output=int(quote.get("outAmount", 0)),
                tokens_received=int(quote.get("outAmount", 0))
            )

        except Exception as e:
            logger.error(f"Swap execution failed: {e}")
            return TradeResult(success=False, error=str(e))

    async def buy_token(
        self,
        contract_address: str,
        amount_sol: float,
        slippage_bps: int = 100
    ) -> TradeResult:
        """
        Buy a token with SOL.

        Args:
            contract_address: Token mint address to buy
            amount_sol: Amount of SOL to spend
            slippage_bps: Slippage tolerance

        Returns:
            TradeResult with transaction details
        """
        lamports = int(amount_sol * 1_000_000_000)

        logger.info(f"🛒 Buying token {contract_address[:8]}... with {amount_sol} SOL")

        # Verify we have enough SOL
        balance = await self.get_balance()
        if balance < amount_sol + 0.01:  # Leave 0.01 SOL for fees
            return TradeResult(success=False, error=f"Insufficient SOL balance: {balance:.4f}")

        quote = await self.get_quote(SOL_MINT, contract_address, lamports, slippage_bps)
        if not quote:
            return TradeResult(success=False, error="Failed to get Jupiter quote")

        expected_tokens = int(quote.get("outAmount", 0))
        logger.info(f"📊 Quote: {amount_sol} SOL → {expected_tokens} tokens")

        result = await self.execute_swap(quote)
        if result.success:
            logger.info(f"✅ BUY SUCCESS: {result.signature}")

        return result

    async def sell_token(
        self,
        contract_address: str,
        percentage: int = 100,
        slippage_bps: int = 100
    ) -> TradeResult:
        """
        Sell a token for SOL.

        Args:
            contract_address: Token mint address to sell
            percentage: Percentage of balance to sell (1-100)
            slippage_bps: Slippage tolerance

        Returns:
            TradeResult with transaction details
        """
        if not self.rpc:
            await self.connect_rpc()

        # Get token balance
        token_amount = await self.get_token_balance(contract_address)

        if token_amount is None or token_amount <= 0:
            return TradeResult(success=False, error="No token balance found")

        sell_amount = (token_amount * percentage) // 100
        if sell_amount <= 0:
            return TradeResult(success=False, error="No tokens to sell")

        logger.info(f"💰 Selling {percentage}% ({sell_amount}) of {contract_address[:8]}...")

        quote = await self.get_quote(contract_address, SOL_MINT, sell_amount, slippage_bps)
        if not quote:
            return TradeResult(success=False, error="Failed to get Jupiter quote for sell")

        expected_sol = int(quote.get("outAmount", 0)) / 1_000_000_000
        logger.info(f"📊 Quote: {sell_amount} tokens → {expected_sol:.4f} SOL")

        result = await self.execute_swap(quote)
        if result.success:
            logger.info(f"✅ SELL SUCCESS: {result.signature}")

        return result

    async def process_pending_trades(self):
        """
        Main loop to process pending trades and sells from database.

        Polls for trades with status 'pending_sigma' and executes buys.
        Also processes pending sell requests.
        """
        logger.info("🚀 Starting Solana trade processor...")
        await self.api.log('info', '🚀 Solana trader started', details=f'Wallet: {self.public_key}')

        while self.running:
            try:
                # Process pending BUY trades
                trades = await self.api.get_pending_sigma_trades()

                for trade in trades:
                    trade_id = trade.get('id')
                    contract_address = trade.get('contract_address')
                    amount_sol = trade.get('allocation_sol', 0.1)

                    logger.info(f"📝 Processing BUY {trade_id}: {contract_address[:8]}... for {amount_sol} SOL")

                    try:
                        result = await self.buy_token(contract_address, amount_sol)

                        if result.success:
                            await self.api.update_trade_bought(
                                trade_id,
                                signature=result.signature,
                                expected_tokens=result.expected_output
                            )
                            await self.api.log(
                                'success',
                                f'✅ BUY EXECUTED: {amount_sol} SOL',
                                details=f'TX: {result.signature}'
                            )
                        else:
                            await self.api.update_trade_failed(trade_id, result.error)
                            await self.api.log(
                                'error',
                                f'❌ BUY FAILED: {result.error}',
                                details=f'Trade ID: {trade_id}'
                            )

                    except Exception as e:
                        logger.error(f"Trade execution error: {e}")
                        await self.api.update_trade_failed(trade_id, str(e))

                # Process pending SELL requests
                sells = await self.api.get_pending_sells()

                for sell in sells:
                    sell_id = sell.get('id')
                    trade_info = sell.get('trades', {})
                    contract_address = trade_info.get('contract_address')
                    percentage = sell.get('percentage', 100)
                    slippage = sell.get('slippage_bps', 100)

                    if not contract_address:
                        logger.warning(f"Sell {sell_id} missing contract address")
                        await self.api.update_sell_failed(sell_id, "Missing contract address")
                        continue

                    logger.info(f"💰 Processing SELL {sell_id}: {percentage}% of {contract_address[:8]}...")

                    try:
                        result = await self.sell_token(contract_address, percentage, slippage)

                        if result.success:
                            # Calculate realized SOL from expected output
                            realized_sol = (result.expected_output or 0) / 1_000_000_000

                            await self.api.update_sell_executed(
                                sell_id,
                                tx_hash=result.signature,
                                realized_sol=realized_sol
                            )
                            await self.api.log(
                                'success',
                                f'💰 SELL EXECUTED: {percentage}% → {realized_sol:.4f} SOL',
                                details=f'TX: {result.signature}'
                            )

                            # Update trade status if this was a TP1 sell (50%)
                            trade_id = sell.get('trade_id')
                            if trade_id and percentage == 50:
                                await self.api.update_partial_tp1(trade_id)
                        else:
                            await self.api.update_sell_failed(sell_id, result.error)
                            await self.api.log(
                                'error',
                                f'❌ SELL FAILED: {result.error}',
                                details=f'Sell ID: {sell_id}'
                            )

                    except Exception as e:
                        logger.error(f"Sell execution error: {e}")
                        await self.api.update_sell_failed(sell_id, str(e))

                # Wait before next poll
                await asyncio.sleep(3)

            except Exception as e:
                logger.error(f"Trade processor error: {e}")
                await asyncio.sleep(10)

    async def monitor_positions(self):
        """
        Monitor open positions and trigger auto-sells based on TP/SL.

        Enhanced with:
        - Trailing stop loss
        - Time-based auto-sell for volatile channels
        - Channel-specific strategies

        This runs as a separate loop alongside trade processing.
        """
        logger.info("📊 Starting enhanced position monitor...")

        while self.running:
            try:
                positions = await self.api.get_open_positions()

                for pos in positions:
                    trade_id = pos.get('id')
                    contract_address = pos.get('contract_address')
                    entry_price = pos.get('entry_price')
                    status = pos.get('status')
                    channel_name = pos.get('channel_name', '')
                    created_at = pos.get('created_at')
                    highest_price = pos.get('highest_price')
                    auto_sell_enabled = pos.get('auto_sell_enabled', True)
                    trailing_stop_enabled = pos.get('trailing_stop_enabled', False)
                    trailing_stop_pct = pos.get('trailing_stop_pct', 15.0)
                    time_based_sell_at = pos.get('time_based_sell_at')

                    if not contract_address or not entry_price:
                        continue

                    if not auto_sell_enabled:
                        continue

                    # Get channel config for strategy parameters
                    config = get_channel_config(channel_name)

                    # Get current token price
                    current_price = await self.get_token_price_sol(contract_address)

                    if current_price is None:
                        # Fallback: use quote to estimate value
                        token_balance = await self.get_token_balance(contract_address)
                        if token_balance and token_balance > 0:
                            quote = await self.get_quote(contract_address, SOL_MINT, token_balance, 100)
                            if quote:
                                current_value = int(quote.get("outAmount", 0)) / 1_000_000_000
                                # Rough price per token
                                current_price = current_value / (token_balance / 1_000_000)

                    if current_price is None:
                        continue

                    # Calculate PnL percentage
                    pnl_pct = ((current_price - entry_price) / entry_price) * 100 if entry_price > 0 else 0

                    # Update highest price for trailing stop
                    new_highest = highest_price
                    if highest_price is None or current_price > highest_price:
                        new_highest = current_price

                    # Check for auto-sell triggers
                    action_needed = None
                    sell_percentage = 100
                    reason = None

                    # 1. Check STOP LOSS
                    stop_loss_pct = pos.get('stop_loss_pct', config.stop_loss_pct)
                    if pnl_pct <= stop_loss_pct:
                        action_needed = 'stop_loss'
                        reason = f"Stop loss hit at {pnl_pct:.1f}%"
                        sell_percentage = 100
                        logger.warning(f"🛑 STOP LOSS for {contract_address[:8]}... PnL: {pnl_pct:.1f}%")

                    # 2. Check TRAILING STOP (only if in profit and trailing enabled)
                    elif trailing_stop_enabled and new_highest and pnl_pct > 0:
                        trailing_pct = trailing_stop_pct or config.trailing_stop_pct
                        drop_from_high = ((new_highest - current_price) / new_highest) * 100 if new_highest > 0 else 0

                        if drop_from_high >= trailing_pct:
                            action_needed = 'trailing_stop'
                            reason = f"Trailing stop: dropped {drop_from_high:.1f}% from high"
                            sell_percentage = 100
                            logger.warning(f"📉 TRAILING STOP for {contract_address[:8]}... dropped {drop_from_high:.1f}% from high")

                    # 3. Check TAKE PROFIT 1 (sell 50%)
                    elif status == 'bought':
                        tp1_pct = pos.get('take_profit_1_pct', config.take_profit_1_pct)
                        if pnl_pct >= tp1_pct:
                            action_needed = 'take_profit_1'
                            reason = f"TP1 hit at {pnl_pct:.1f}%"
                            sell_percentage = 50
                            logger.info(f"🎯 TP1 for {contract_address[:8]}... PnL: {pnl_pct:.1f}%")

                    # 4. Check TAKE PROFIT 2 (sell remaining)
                    elif status == 'partial_tp1':
                        tp2_pct = pos.get('take_profit_2_pct', config.take_profit_2_pct)
                        if pnl_pct >= tp2_pct:
                            action_needed = 'take_profit_2'
                            reason = f"TP2 hit at {pnl_pct:.1f}%"
                            sell_percentage = 100
                            logger.info(f"🎯🎯 TP2 for {contract_address[:8]}... PnL: {pnl_pct:.1f}%")

                    # 5. Check TIME-BASED SELL (for volatile channels)
                    if not action_needed and time_based_sell_at:
                        try:
                            sell_time = datetime.fromisoformat(time_based_sell_at.replace('Z', '+00:00'))
                            if datetime.now(timezone.utc) >= sell_time:
                                action_needed = 'time_based'
                                reason = f"Time-based auto-sell triggered"
                                sell_percentage = 100
                                logger.info(f"⏰ TIME-BASED SELL for {contract_address[:8]}...")
                        except Exception as e:
                            logger.debug(f"Error parsing time_based_sell_at: {e}")

                    # Update position price and highest price
                    result = await self.api.update_position_price(
                        trade_id,
                        current_price=current_price,
                        current_value_sol=None,
                        highest_price=new_highest
                    )

                    # Execute auto-sell if triggered
                    if action_needed:
                        logger.info(f"🔔 {action_needed.upper()} triggered for {contract_address[:8]}... (PnL: {pnl_pct:.1f}%)")

                        await self.api.trigger_auto_sell(
                            trade_id,
                            percentage=sell_percentage,
                            reason=reason
                        )

                await asyncio.sleep(POSITION_CHECK_INTERVAL)

            except Exception as e:
                logger.error(f"Position monitor error: {e}")
                await asyncio.sleep(30)

    async def run(self):
        """Run both trade processing and position monitoring."""
        await asyncio.gather(
            self.process_pending_trades(),
            self.monitor_positions()
        )

    async def stop(self):
        """Stop the trader gracefully."""
        self.running = False
        await self.http.aclose()
        if self.rpc:
            await self.rpc.close()
        logger.info("Solana trader stopped")
