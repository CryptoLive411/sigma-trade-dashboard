import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Activity, Wallet, Target, Clock } from "lucide-react";
import type { Trade } from "@/hooks/useTrades";
import type { Position } from "@/hooks/usePositions";

interface StatsCardsProps {
  trades: Trade[];
  positions: Position[];
}

export function StatsCards({ trades, positions }: StatsCardsProps) {
  const activePositions = positions.filter(p => p.is_active);
  const completedTrades = trades.filter(t => t.status === "sold");
  
  const totalPnlSol = completedTrades.reduce((sum, t) => sum + (t.pnl_sol || 0), 0);
  const winningTrades = completedTrades.filter(t => (t.pnl_sol || 0) > 0);
  const winRate = completedTrades.length > 0 
    ? (winningTrades.length / completedTrades.length * 100).toFixed(1)
    : "0";
  
  const unrealizedPnl = activePositions.reduce((sum, p) => sum + (p.unrealized_pnl_sol || 0), 0);
  const pendingTrades = trades.filter(t => ["pending_sigma", "pending_buy"].includes(t.status));

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total P&L</CardTitle>
          {totalPnlSol >= 0 ? (
            <TrendingUp className="h-4 w-4 text-green-500" />
          ) : (
            <TrendingDown className="h-4 w-4 text-red-500" />
          )}
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${totalPnlSol >= 0 ? "text-green-500" : "text-red-500"}`}>
            {totalPnlSol >= 0 ? "+" : ""}{totalPnlSol.toFixed(4)} SOL
          </div>
          <p className="text-xs text-muted-foreground">
            From {completedTrades.length} completed trades
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Win Rate</CardTitle>
          <Target className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{winRate}%</div>
          <p className="text-xs text-muted-foreground">
            {winningTrades.length}/{completedTrades.length} winning trades
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Active Positions</CardTitle>
          <Wallet className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{activePositions.length}</div>
          <p className={`text-xs ${unrealizedPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
            {unrealizedPnl >= 0 ? "+" : ""}{unrealizedPnl.toFixed(4)} SOL unrealized
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Pending Trades</CardTitle>
          <Clock className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{pendingTrades.length}</div>
          <p className="text-xs text-muted-foreground">
            Awaiting execution
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
