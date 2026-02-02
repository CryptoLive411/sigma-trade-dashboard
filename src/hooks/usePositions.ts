import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type Position = Tables<"positions">;

export function usePositions() {
  return useQuery({
    queryKey: ["positions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("*")
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data as Position[];
    },
    refetchInterval: 5000,
  });
}

export function useActivePositions() {
  return useQuery({
    queryKey: ["positions", "active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data as Position[];
    },
    refetchInterval: 3000,
  });
}

export function useClosePosition() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ positionId, sellPct = 100 }: { positionId: string; sellPct?: number }) => {
      // Create a sell order
      const { data: position, error: posError } = await supabase
        .from("positions")
        .select("*")
        .eq("id", positionId)
        .single();
      
      if (posError) throw posError;
      
      const tokensToSell = (position.tokens_held * sellPct) / 100;
      
      const { error } = await supabase
        .from("sell_orders")
        .insert({
          position_id: positionId,
          trade_id: position.trade_id,
          contract_address: position.contract_address,
          chain: position.chain,
          tokens_to_sell: tokensToSell,
          sell_pct: sellPct,
          reason: "manual_close",
          status: "pending",
        });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["positions"] });
    },
  });
}
