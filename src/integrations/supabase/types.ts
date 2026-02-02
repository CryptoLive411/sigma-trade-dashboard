export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      bot_settings: {
        Row: {
          created_at: string
          description: string | null
          id: string
          setting_key: string
          setting_value: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          setting_key: string
          setting_value: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          setting_key?: string
          setting_value?: Json
          updated_at?: string
        }
        Relationships: []
      }
      channels: {
        Row: {
          allocation_sol: number | null
          auto_buy: boolean
          category: Database["public"]["Enums"]["channel_category"]
          chain: Database["public"]["Enums"]["chain_type"]
          channel_id: string
          created_at: string
          enabled: boolean
          id: string
          max_hold_minutes: number | null
          name: string
          platform: string
          stop_loss_pct: number | null
          take_profit_pct: number | null
          updated_at: string
        }
        Insert: {
          allocation_sol?: number | null
          auto_buy?: boolean
          category?: Database["public"]["Enums"]["channel_category"]
          chain?: Database["public"]["Enums"]["chain_type"]
          channel_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          max_hold_minutes?: number | null
          name: string
          platform: string
          stop_loss_pct?: number | null
          take_profit_pct?: number | null
          updated_at?: string
        }
        Update: {
          allocation_sol?: number | null
          auto_buy?: boolean
          category?: Database["public"]["Enums"]["channel_category"]
          chain?: Database["public"]["Enums"]["chain_type"]
          channel_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          max_hold_minutes?: number | null
          name?: string
          platform?: string
          stop_loss_pct?: number | null
          take_profit_pct?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          chain: Database["public"]["Enums"]["chain_type"]
          contract_address: string
          created_at: string
          current_price: number | null
          entry_price: number
          highest_price: number | null
          id: string
          is_active: boolean
          last_price_check: string | null
          lowest_price: number | null
          max_hold_until: string | null
          stop_loss_pct: number | null
          take_profit_pct: number | null
          token_symbol: string | null
          tokens_held: number
          trade_id: string
          trailing_stop_pct: number | null
          unrealized_pnl_pct: number | null
          unrealized_pnl_sol: number | null
          updated_at: string
        }
        Insert: {
          chain?: Database["public"]["Enums"]["chain_type"]
          contract_address: string
          created_at?: string
          current_price?: number | null
          entry_price: number
          highest_price?: number | null
          id?: string
          is_active?: boolean
          last_price_check?: string | null
          lowest_price?: number | null
          max_hold_until?: string | null
          stop_loss_pct?: number | null
          take_profit_pct?: number | null
          token_symbol?: string | null
          tokens_held: number
          trade_id: string
          trailing_stop_pct?: number | null
          unrealized_pnl_pct?: number | null
          unrealized_pnl_sol?: number | null
          updated_at?: string
        }
        Update: {
          chain?: Database["public"]["Enums"]["chain_type"]
          contract_address?: string
          created_at?: string
          current_price?: number | null
          entry_price?: number
          highest_price?: number | null
          id?: string
          is_active?: boolean
          last_price_check?: string | null
          lowest_price?: number | null
          max_hold_until?: string | null
          stop_loss_pct?: number | null
          take_profit_pct?: number | null
          token_symbol?: string | null
          tokens_held?: number
          trade_id?: string
          trailing_stop_pct?: number | null
          unrealized_pnl_pct?: number | null
          unrealized_pnl_sol?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      sell_orders: {
        Row: {
          chain: Database["public"]["Enums"]["chain_type"]
          contract_address: string
          created_at: string
          error_message: string | null
          executed_at: string | null
          id: string
          position_id: string
          realized_sol: number | null
          reason: string
          sell_pct: number
          status: string
          tokens_to_sell: number
          trade_id: string
          tx_signature: string | null
        }
        Insert: {
          chain?: Database["public"]["Enums"]["chain_type"]
          contract_address: string
          created_at?: string
          error_message?: string | null
          executed_at?: string | null
          id?: string
          position_id: string
          realized_sol?: number | null
          reason: string
          sell_pct?: number
          status?: string
          tokens_to_sell: number
          trade_id: string
          tx_signature?: string | null
        }
        Update: {
          chain?: Database["public"]["Enums"]["chain_type"]
          contract_address?: string
          created_at?: string
          error_message?: string | null
          executed_at?: string | null
          id?: string
          position_id?: string
          realized_sol?: number | null
          reason?: string
          sell_pct?: number
          status?: string
          tokens_to_sell?: number
          trade_id?: string
          tx_signature?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sell_orders_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sell_orders_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_events: {
        Row: {
          created_at: string
          event_data: Json | null
          event_type: string
          id: string
          trade_id: string
        }
        Insert: {
          created_at?: string
          event_data?: Json | null
          event_type: string
          id?: string
          trade_id: string
        }
        Update: {
          created_at?: string
          event_data?: Json | null
          event_type?: string
          id?: string
          trade_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_events_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          allocation_sol: number
          bought_at: string | null
          buy_price: number | null
          buy_slippage_pct: number | null
          buy_tx_signature: string | null
          chain: Database["public"]["Enums"]["chain_type"]
          channel_category:
            | Database["public"]["Enums"]["channel_category"]
            | null
          channel_id: string | null
          contract_address: string
          created_at: string
          error_message: string | null
          id: string
          metadata: Json | null
          pnl_pct: number | null
          pnl_sol: number | null
          realized_sol: number | null
          sell_price: number | null
          sell_reason: string | null
          sell_tx_signature: string | null
          sold_at: string | null
          source_message: string | null
          status: Database["public"]["Enums"]["trade_status"]
          token_name: string | null
          token_symbol: string | null
          tokens_received: number | null
          tokens_sold: number | null
          updated_at: string
        }
        Insert: {
          allocation_sol: number
          bought_at?: string | null
          buy_price?: number | null
          buy_slippage_pct?: number | null
          buy_tx_signature?: string | null
          chain?: Database["public"]["Enums"]["chain_type"]
          channel_category?:
            | Database["public"]["Enums"]["channel_category"]
            | null
          channel_id?: string | null
          contract_address: string
          created_at?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          pnl_pct?: number | null
          pnl_sol?: number | null
          realized_sol?: number | null
          sell_price?: number | null
          sell_reason?: string | null
          sell_tx_signature?: string | null
          sold_at?: string | null
          source_message?: string | null
          status?: Database["public"]["Enums"]["trade_status"]
          token_name?: string | null
          token_symbol?: string | null
          tokens_received?: number | null
          tokens_sold?: number | null
          updated_at?: string
        }
        Update: {
          allocation_sol?: number
          bought_at?: string | null
          buy_price?: number | null
          buy_slippage_pct?: number | null
          buy_tx_signature?: string | null
          chain?: Database["public"]["Enums"]["chain_type"]
          channel_category?:
            | Database["public"]["Enums"]["channel_category"]
            | null
          channel_id?: string | null
          contract_address?: string
          created_at?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          pnl_pct?: number | null
          pnl_sol?: number | null
          realized_sol?: number | null
          sell_price?: number | null
          sell_reason?: string | null
          sell_tx_signature?: string | null
          sold_at?: string | null
          source_message?: string | null
          status?: Database["public"]["Enums"]["trade_status"]
          token_name?: string | null
          token_symbol?: string | null
          tokens_received?: number | null
          tokens_sold?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trades_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_heartbeats: {
        Row: {
          created_at: string
          id: string
          last_heartbeat: string
          metadata: Json | null
          status: string
          worker_name: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_heartbeat?: string
          metadata?: Json | null
          status?: string
          worker_name: string
        }
        Update: {
          created_at?: string
          id?: string
          last_heartbeat?: string
          metadata?: Json | null
          status?: string
          worker_name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      chain_type: "solana" | "base"
      channel_category:
        | "alpha_calls"
        | "whale_tracking"
        | "insider_alerts"
        | "degen_plays"
        | "verified_callers"
        | "custom"
      trade_status:
        | "pending_sigma"
        | "pending_buy"
        | "bought"
        | "pending_sell"
        | "sold"
        | "failed"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      chain_type: ["solana", "base"],
      channel_category: [
        "alpha_calls",
        "whale_tracking",
        "insider_alerts",
        "degen_plays",
        "verified_callers",
        "custom",
      ],
      trade_status: [
        "pending_sigma",
        "pending_buy",
        "bought",
        "pending_sell",
        "sold",
        "failed",
        "cancelled",
      ],
    },
  },
} as const
