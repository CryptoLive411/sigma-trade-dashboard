import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

export type Trade = Tables<"trades">;
export type TradeInsert = TablesInsert<"trades">;

export function useTrades() {
  return useQuery({
    queryKey: ["trades"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      
      if (error) throw error;
      return data as Trade[];
    },
    refetchInterval: 5000,
  });
}

export function useActiveTrades() {
  return useQuery({
    queryKey: ["trades", "active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("*")
        .in("status", ["pending_sigma", "pending_buy", "bought", "pending_sell"])
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data as Trade[];
    },
    refetchInterval: 3000,
  });
}

export function useCreateTrade() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (trade: TradeInsert) => {
      const { data, error } = await supabase
        .from("trades")
        .insert(trade)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trades"] });
    },
  });
}

export function useCancelTrade() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (tradeId: string) => {
      const { error } = await supabase
        .from("trades")
        .update({ status: "cancelled" })
        .eq("id", tradeId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trades"] });
    },
  });
}
