import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCreateTrade } from "@/hooks/useTrades";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Rocket } from "lucide-react";
import type { Database } from "@/integrations/supabase/types";

type ChainType = Database["public"]["Enums"]["chain_type"];

export function QuickTrade() {
  const [contractAddress, setContractAddress] = useState("");
  const [allocationSol, setAllocationSol] = useState("0.1");
  const [chain, setChain] = useState<ChainType>("solana");
  
  const createTrade = useCreateTrade();
  const { toast } = useToast();
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!contractAddress.trim()) {
      toast({
        title: "Error",
        description: "Please enter a contract address",
        variant: "destructive",
      });
      return;
    }
    
    try {
      await createTrade.mutateAsync({
        contract_address: contractAddress.trim(),
        allocation_sol: parseFloat(allocationSol),
        chain,
        status: "pending_sigma",
      });
      
      toast({
        title: "Trade Queued",
        description: "Your trade has been added to the queue",
      });
      
      setContractAddress("");
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create trade",
        variant: "destructive",
      });
    }
  };
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-5 w-5" />
          Quick Trade
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="contract">Contract Address</Label>
            <Input
              id="contract"
              placeholder="Enter token contract address..."
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="chain">Chain</Label>
              <Select value={chain} onValueChange={(v) => setChain(v as ChainType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="solana">Solana</SelectItem>
                  <SelectItem value="base">Base</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="allocation">Allocation (SOL)</Label>
              <Input
                id="allocation"
                type="number"
                step="0.01"
                min="0.01"
                value={allocationSol}
                onChange={(e) => setAllocationSol(e.target.value)}
                className="font-mono"
              />
            </div>
          </div>
          
          <Button 
            type="submit" 
            className="w-full"
            disabled={createTrade.isPending}
          >
            {createTrade.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Queueing...
              </>
            ) : (
              <>
                <Rocket className="mr-2 h-4 w-4" />
                Queue Trade
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
