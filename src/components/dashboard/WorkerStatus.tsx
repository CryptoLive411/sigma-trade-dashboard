import { Badge } from "@/components/ui/badge";
import { useWorkerStatus, isWorkerOnline } from "@/hooks/useWorkerStatus";
import { Activity, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export function WorkerStatus() {
  const { data: workers, isLoading } = useWorkerStatus();
  
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Activity className="h-4 w-4 animate-pulse" />
        <span className="text-sm">Checking worker status...</span>
      </div>
    );
  }
  
  const mainWorker = workers?.find(w => w.worker_name === "sigma_bot");
  const isOnline = isWorkerOnline(mainWorker || null);
  
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        {isOnline ? (
          <>
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
            </span>
            <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30">
              Bot Online
            </Badge>
          </>
        ) : (
          <>
            <AlertCircle className="h-4 w-4 text-red-500" />
            <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/30">
              Bot Offline
            </Badge>
          </>
        )}
      </div>
      
      {mainWorker && (
        <span className="text-xs text-muted-foreground">
          Last seen: {formatDistanceToNow(new Date(mainWorker.last_heartbeat), { addSuffix: true })}
        </span>
      )}
    </div>
  );
}
