import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type WorkerHeartbeat = Tables<"worker_heartbeats">;

export function useWorkerStatus() {
  return useQuery({
    queryKey: ["worker_heartbeats"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("worker_heartbeats")
        .select("*")
        .order("last_heartbeat", { ascending: false });
      
      if (error) throw error;
      return data as WorkerHeartbeat[];
    },
    refetchInterval: 10000,
  });
}

export function isWorkerOnline(heartbeat: WorkerHeartbeat | null): boolean {
  if (!heartbeat) return false;
  const lastBeat = new Date(heartbeat.last_heartbeat);
  const now = new Date();
  const diffMs = now.getTime() - lastBeat.getTime();
  return diffMs < 30000; // Consider online if heartbeat within 30 seconds
}
