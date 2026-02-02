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
import { ExternalLink, DollarSign } from "lucide-react";
import type { Position } from "@/hooks/usePositions";
import { formatDistanceToNow } from "date-fns";

interface PositionsTableProps {
  positions: Position[];
  onClose?: (positionId: string, sellPct?: number) => void;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getSolscanUrl(address: string, chain: string): string {
  if (chain === "solana") {
    return `https://solscan.io/token/${address}`;
  }
  return `https://basescan.org/token/${address}`;
}

export function PositionsTable({ positions, onClose }: PositionsTableProps) {
  const activePositions = positions.filter(p => p.is_active);
  
  if (activePositions.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        No active positions
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
            <TableHead className="text-right">Entry Price</TableHead>
            <TableHead className="text-right">Current</TableHead>
            <TableHead className="text-right">P&L %</TableHead>
            <TableHead className="text-right">P&L SOL</TableHead>
            <TableHead>TP/SL</TableHead>
            <TableHead>Opened</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activePositions.map((position) => {
            const pnlPct = position.unrealized_pnl_pct || 0;
            const pnlSol = position.unrealized_pnl_sol || 0;
            
            return (
              <TableRow key={position.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <span>{position.token_symbol || truncateAddress(position.contract_address)}</span>
                    <a
                      href={getSolscanUrl(position.contract_address, position.chain)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {position.chain}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  ${position.entry_price.toExponential(2)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {position.current_price 
                    ? `$${position.current_price.toExponential(2)}`
                    : "-"}
                </TableCell>
                <TableCell className="text-right font-mono">
                  <span className={pnlPct >= 0 ? "text-green-500" : "text-red-500"}>
                    {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono">
                  <span className={pnlSol >= 0 ? "text-green-500" : "text-red-500"}>
                    {pnlSol >= 0 ? "+" : ""}{pnlSol.toFixed(4)}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1 text-xs">
                    {position.take_profit_pct && (
                      <Badge variant="outline" className="text-green-500 border-green-500/30">
                        TP {position.take_profit_pct}%
                      </Badge>
                    )}
                    {position.stop_loss_pct && (
                      <Badge variant="outline" className="text-red-500 border-red-500/30">
                        SL {position.stop_loss_pct}%
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDistanceToNow(new Date(position.created_at), { addSuffix: true })}
                </TableCell>
                <TableCell className="text-right">
                  {onClose && (
                    <div className="flex gap-1 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onClose(position.id, 50)}
                        className="h-7 text-xs"
                      >
                        50%
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => onClose(position.id, 100)}
                        className="h-7 text-xs"
                      >
                        <DollarSign className="h-3 w-3 mr-1" />
                        Close
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
