import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, X } from "lucide-react";
import type { Trade } from "@/hooks/useTrades";
import { formatDistanceToNow } from "date-fns";

interface TradesTableProps {
  trades: Trade[];
  onCancel?: (tradeId: string) => void;
}

const statusColors: Record<string, string> = {
  pending_sigma: "bg-yellow-500/20 text-yellow-500 border-yellow-500/30",
  pending_buy: "bg-blue-500/20 text-blue-500 border-blue-500/30",
  bought: "bg-green-500/20 text-green-500 border-green-500/30",
  pending_sell: "bg-orange-500/20 text-orange-500 border-orange-500/30",
  sold: "bg-muted text-muted-foreground border-muted",
  failed: "bg-red-500/20 text-red-500 border-red-500/30",
  cancelled: "bg-muted text-muted-foreground border-muted",
};

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getSolscanUrl(address: string, chain: string): string {
  if (chain === "solana") {
    return `https://solscan.io/token/${address}`;
  }
  return `https://basescan.org/token/${address}`;
}

export function TradesTable({ trades, onCancel }: TradesTableProps) {
  if (trades.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        No trades yet
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Token</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Allocation</TableHead>
            <TableHead className="text-right">P&L</TableHead>
            <TableHead>Time</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((trade) => (
            <TableRow key={trade.id}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  <span>{trade.token_symbol || truncateAddress(trade.contract_address)}</span>
                  <a
                    href={getSolscanUrl(trade.contract_address, trade.chain)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                {trade.token_name && (
                  <div className="text-xs text-muted-foreground">{trade.token_name}</div>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {trade.chain}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge className={statusColors[trade.status]}>
                  {trade.status.replace("_", " ")}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono">
                {trade.allocation_sol.toFixed(3)} SOL
              </TableCell>
              <TableCell className="text-right font-mono">
                {trade.pnl_sol !== null ? (
                  <span className={trade.pnl_sol >= 0 ? "text-green-500" : "text-red-500"}>
                    {trade.pnl_sol >= 0 ? "+" : ""}{trade.pnl_sol.toFixed(4)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDistanceToNow(new Date(trade.created_at), { addSuffix: true })}
              </TableCell>
              <TableCell className="text-right">
                {["pending_sigma", "pending_buy"].includes(trade.status) && onCancel && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onCancel(trade.id)}
                    className="h-8 w-8 text-red-500 hover:text-red-600"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
