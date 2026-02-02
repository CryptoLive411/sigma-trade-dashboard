import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Verify worker API key
  const authHeader = req.headers.get("Authorization");
  const workerApiKey = Deno.env.get("WORKER_API_KEY");
  
  if (!authHeader || authHeader !== `Bearer ${workerApiKey}`) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    switch (action) {
      // ========== HEARTBEAT ==========
      case "heartbeat": {
        const body = await req.json();
        const { worker_name, metadata } = body;
        
        const { error } = await supabase
          .from("worker_heartbeats")
          .upsert({
            worker_name,
            last_heartbeat: new Date().toISOString(),
            status: "online",
            metadata,
          }, { onConflict: "worker_name" });
        
        if (error) throw error;
        return jsonResponse({ success: true });
      }

      // ========== GET PENDING SIGMA TRADES ==========
      case "get_pending_sigma_trades": {
        const { data, error } = await supabase
          .from("trades")
          .select("*, channels(*)")
          .eq("status", "pending_sigma")
          .order("created_at", { ascending: true })
          .limit(10);
        
        if (error) throw error;
        return jsonResponse({ trades: data });
      }

      // ========== UPDATE TRADE TO PENDING_BUY ==========
      case "update_trade_pending_buy": {
        const body = await req.json();
        const { trade_id } = body;
        
        const { error } = await supabase
          .from("trades")
          .update({ status: "pending_buy" })
          .eq("id", trade_id);
        
        if (error) throw error;
        
        // Log event
        await supabase.from("trade_events").insert({
          trade_id,
          event_type: "pending_buy",
          event_data: { timestamp: new Date().toISOString() },
        });
        
        return jsonResponse({ success: true });
      }

      // ========== UPDATE TRADE BOUGHT ==========
      case "update_trade_bought": {
        const body = await req.json();
        const { trade_id, signature, tokens_received, buy_price, token_name, token_symbol } = body;
        
        // Update trade
        const { data: trade, error: tradeError } = await supabase
          .from("trades")
          .update({
            status: "bought",
            bought_at: new Date().toISOString(),
            buy_tx_signature: signature,
            tokens_received,
            buy_price,
            token_name,
            token_symbol,
          })
          .eq("id", trade_id)
          .select()
          .single();
        
        if (tradeError) throw tradeError;
        
        // Get channel settings for TP/SL
        let takeProfitPct = 100;
        let stopLossPct = -50;
        let maxHoldMinutes: number | null = null;
        
        if (trade.channel_id) {
          const { data: channel } = await supabase
            .from("channels")
            .select("*")
            .eq("id", trade.channel_id)
            .single();
          
          if (channel) {
            takeProfitPct = channel.take_profit_pct || 100;
            stopLossPct = channel.stop_loss_pct || -50;
            maxHoldMinutes = channel.max_hold_minutes;
          }
        }
        
        // Create position
        const maxHoldUntil = maxHoldMinutes 
          ? new Date(Date.now() + maxHoldMinutes * 60 * 1000).toISOString()
          : null;
        
        const { error: posError } = await supabase
          .from("positions")
          .insert({
            trade_id,
            contract_address: trade.contract_address,
            chain: trade.chain,
            entry_price: buy_price,
            tokens_held: tokens_received,
            token_symbol,
            take_profit_pct: takeProfitPct,
            stop_loss_pct: stopLossPct,
            max_hold_until: maxHoldUntil,
            is_active: true,
          });
        
        if (posError) throw posError;
        
        // Log event
        await supabase.from("trade_events").insert({
          trade_id,
          event_type: "bought",
          event_data: { signature, tokens_received, buy_price },
        });
        
        return jsonResponse({ success: true, trade });
      }

      // ========== UPDATE TRADE FAILED ==========
      case "update_trade_failed": {
        const body = await req.json();
        const { trade_id, error_message } = body;
        
        const { error } = await supabase
          .from("trades")
          .update({
            status: "failed",
            error_message,
          })
          .eq("id", trade_id);
        
        if (error) throw error;
        
        // Log event
        await supabase.from("trade_events").insert({
          trade_id,
          event_type: "failed",
          event_data: { error_message },
        });
        
        return jsonResponse({ success: true });
      }

      // ========== GET ACTIVE POSITIONS ==========
      case "get_active_positions": {
        const { data, error } = await supabase
          .from("positions")
          .select("*, trades(*)")
          .eq("is_active", true)
          .order("created_at", { ascending: true });
        
        if (error) throw error;
        return jsonResponse({ positions: data });
      }

      // ========== UPDATE POSITION PRICE ==========
      case "update_position_price": {
        const body = await req.json();
        const { position_id, current_price } = body;
        
        // Get position
        const { data: position, error: posError } = await supabase
          .from("positions")
          .select("*")
          .eq("id", position_id)
          .single();
        
        if (posError) throw posError;
        
        const pnlPct = ((current_price - position.entry_price) / position.entry_price) * 100;
        const pnlSol = (current_price - position.entry_price) * position.tokens_held;
        
        // Track highest/lowest prices
        const highestPrice = Math.max(position.highest_price || 0, current_price);
        const lowestPrice = position.lowest_price 
          ? Math.min(position.lowest_price, current_price)
          : current_price;
        
        const { error } = await supabase
          .from("positions")
          .update({
            current_price,
            unrealized_pnl_pct: pnlPct,
            unrealized_pnl_sol: pnlSol,
            highest_price: highestPrice,
            lowest_price: lowestPrice,
            last_price_check: new Date().toISOString(),
          })
          .eq("id", position_id);
        
        if (error) throw error;
        
        // Check if should trigger auto-sell
        let shouldSell = false;
        let sellReason = "";
        
        if (position.take_profit_pct && pnlPct >= position.take_profit_pct) {
          shouldSell = true;
          sellReason = "take_profit";
        } else if (position.stop_loss_pct && pnlPct <= position.stop_loss_pct) {
          shouldSell = true;
          sellReason = "stop_loss";
        } else if (position.max_hold_until && new Date() >= new Date(position.max_hold_until)) {
          shouldSell = true;
          sellReason = "max_hold_time";
        } else if (position.trailing_stop_pct && position.highest_price) {
          const dropFromHigh = ((current_price - position.highest_price) / position.highest_price) * 100;
          if (dropFromHigh <= -position.trailing_stop_pct) {
            shouldSell = true;
            sellReason = "trailing_stop";
          }
        }
        
        return jsonResponse({ 
          success: true, 
          pnl_pct: pnlPct,
          should_sell: shouldSell,
          sell_reason: sellReason,
        });
      }

      // ========== GET PENDING SELLS ==========
      case "get_pending_sells": {
        const { data, error } = await supabase
          .from("sell_orders")
          .select("*, positions(*)")
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(10);
        
        if (error) throw error;
        return jsonResponse({ sell_orders: data });
      }

      // ========== CREATE SELL ORDER ==========
      case "create_sell_order": {
        const body = await req.json();
        const { position_id, sell_pct, reason } = body;
        
        const { data: position, error: posError } = await supabase
          .from("positions")
          .select("*")
          .eq("id", position_id)
          .single();
        
        if (posError) throw posError;
        
        const tokensToSell = (position.tokens_held * sell_pct) / 100;
        
        const { data, error } = await supabase
          .from("sell_orders")
          .insert({
            position_id,
            trade_id: position.trade_id,
            contract_address: position.contract_address,
            chain: position.chain,
            tokens_to_sell: tokensToSell,
            sell_pct,
            reason,
            status: "pending",
          })
          .select()
          .single();
        
        if (error) throw error;
        return jsonResponse({ success: true, sell_order: data });
      }

      // ========== UPDATE SELL EXECUTED ==========
      case "update_sell_executed": {
        const body = await req.json();
        const { sell_id, tx_hash, realized_sol } = body;
        
        // Get sell order
        const { data: sellOrder, error: sellError } = await supabase
          .from("sell_orders")
          .select("*")
          .eq("id", sell_id)
          .single();
        
        if (sellError) throw sellError;
        
        // Update sell order
        await supabase
          .from("sell_orders")
          .update({
            status: "executed",
            executed_at: new Date().toISOString(),
            tx_signature: tx_hash,
            realized_sol,
          })
          .eq("id", sell_id);
        
        // Get position
        const { data: position, error: posError } = await supabase
          .from("positions")
          .select("*")
          .eq("id", sellOrder.position_id)
          .single();
        
        if (posError) throw posError;
        
        // Update position tokens
        const newTokensHeld = position.tokens_held - sellOrder.tokens_to_sell;
        const isFullSell = newTokensHeld <= 0 || sellOrder.sell_pct >= 100;
        
        await supabase
          .from("positions")
          .update({
            tokens_held: Math.max(0, newTokensHeld),
            is_active: !isFullSell,
          })
          .eq("id", sellOrder.position_id);
        
        // If full sell, update trade
        if (isFullSell) {
          const { data: trade } = await supabase
            .from("trades")
            .select("*")
            .eq("id", position.trade_id)
            .single();
          
          if (trade) {
            const pnlSol = realized_sol - trade.allocation_sol;
            const pnlPct = (pnlSol / trade.allocation_sol) * 100;
            
            await supabase
              .from("trades")
              .update({
                status: "sold",
                sold_at: new Date().toISOString(),
                sell_tx_signature: tx_hash,
                realized_sol,
                tokens_sold: position.tokens_held,
                sell_reason: sellOrder.reason,
                pnl_sol: pnlSol,
                pnl_pct: pnlPct,
              })
              .eq("id", position.trade_id);
          }
        }
        
        // Log event
        await supabase.from("trade_events").insert({
          trade_id: position.trade_id,
          event_type: "sold",
          event_data: { tx_hash, realized_sol, sell_pct: sellOrder.sell_pct },
        });
        
        return jsonResponse({ success: true });
      }

      // ========== QUEUE TRADE CA ==========
      case "queue_trade_ca": {
        const body = await req.json();
        const { contract_address, channel_id, source_message, chain = "solana" } = body;
        
        // Get channel settings
        const { data: channel, error: channelError } = await supabase
          .from("channels")
          .select("*")
          .eq("id", channel_id)
          .single();
        
        if (channelError) throw channelError;
        
        // Check if trade already exists for this CA
        const { data: existing } = await supabase
          .from("trades")
          .select("id")
          .eq("contract_address", contract_address)
          .in("status", ["pending_sigma", "pending_buy", "bought"])
          .single();
        
        if (existing) {
          return jsonResponse({ success: false, error: "Trade already exists", trade_id: existing.id });
        }
        
        // Create trade
        const { data: trade, error } = await supabase
          .from("trades")
          .insert({
            contract_address,
            chain,
            channel_id,
            channel_category: channel.category,
            allocation_sol: channel.allocation_sol || 0.1,
            source_message,
            status: "pending_sigma",
          })
          .select()
          .single();
        
        if (error) throw error;
        
        return jsonResponse({ success: true, trade });
      }

      // ========== GET BOT SETTINGS ==========
      case "get_bot_settings": {
        const { data, error } = await supabase
          .from("bot_settings")
          .select("*");
        
        if (error) throw error;
        
        const settings: Record<string, unknown> = {};
        for (const row of data || []) {
          settings[row.setting_key] = row.setting_value;
        }
        
        return jsonResponse({ settings });
      }

      // ========== GET CHANNELS ==========
      case "get_channels": {
        const { data, error } = await supabase
          .from("channels")
          .select("*")
          .eq("enabled", true);
        
        if (error) throw error;
        return jsonResponse({ channels: data });
      }

      default:
        return new Response(
          JSON.stringify({ error: "Unknown action" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error) {
    console.error("Worker-pull error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function jsonResponse(data: unknown) {
  return new Response(
    JSON.stringify(data),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
