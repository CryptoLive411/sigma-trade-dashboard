import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, Json } from "@/integrations/supabase/types";

export type BotSetting = Tables<"bot_settings">;

export function useBotSettings() {
  return useQuery({
    queryKey: ["bot_settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bot_settings")
        .select("*");
      
      if (error) throw error;
      return data as BotSetting[];
    },
  });
}

export function useBotSetting(key: string) {
  return useQuery({
    queryKey: ["bot_settings", key],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bot_settings")
        .select("*")
        .eq("setting_key", key)
        .maybeSingle();
      
      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateBotSetting() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ key, value, description }: { key: string; value: Json; description?: string }) => {
      const { error } = await supabase
        .from("bot_settings")
        .upsert({
          setting_key: key,
          setting_value: value,
          description,
        }, { onConflict: "setting_key" });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bot_settings"] });
    },
  });
}
