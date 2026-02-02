import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatsCards } from "@/components/dashboard/StatsCards";
import { TradesTable } from "@/components/dashboard/TradesTable";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { WorkerStatus } from "@/components/dashboard/WorkerStatus";
import { QuickTrade } from "@/components/dashboard/QuickTrade";
import { ChannelsManager } from "@/components/dashboard/ChannelsManager";
import { useTrades, useCancelTrade } from "@/hooks/useTrades";
import { usePositions, useClosePosition } from "@/hooks/usePositions";
import { useToast } from "@/hooks/use-toast";
import { Bot, LayoutDashboard, History, Radio } from "lucide-react";

const Index = () => {
  const { data: trades = [], isLoading: tradesLoading } = useTrades();
  const { data: positions = [], isLoading: positionsLoading } = usePositions();
  const cancelTrade = useCancelTrade();
  const closePosition = useClosePosition();
  const { toast } = useToast();
  
  const handleCancelTrade = async (tradeId: string) => {
    try {
      await cancelTrade.mutateAsync(tradeId);
      toast({ title: "Trade cancelled" });
    } catch (error) {
      toast({ title: "Failed to cancel trade", variant: "destructive" });
    }
  };
  
  const handleClosePosition = async (positionId: string, sellPct?: number) => {
    try {
      await closePosition.mutateAsync({ positionId, sellPct });
      toast({ title: "Sell order created" });
    } catch (error) {
      toast({ title: "Failed to create sell order", variant: "destructive" });
    }
  };
  
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-3">
            <Bot className="h-8 w-8 text-primary" />
            <div>
              <h1 className="text-xl font-bold">Sigma Trading Bot</h1>
              <p className="text-xs text-muted-foreground">Solana & Base Sniper</p>
            </div>
          </div>
          <WorkerStatus />
        </div>
      </header>
      
      {/* Main Content */}
      <main className="container py-6 space-y-6">
        {/* Stats */}
        <StatsCards trades={trades} positions={positions} />
        
        {/* Tabs */}
        <Tabs defaultValue="dashboard" className="space-y-4">
          <TabsList>
            <TabsTrigger value="dashboard" className="gap-2">
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-2">
              <History className="h-4 w-4" />
              Trade History
            </TabsTrigger>
            <TabsTrigger value="channels" className="gap-2">
              <Radio className="h-4 w-4" />
              Channels
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="dashboard" className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2 space-y-6">
                {/* Active Positions */}
                <div>
                  <h2 className="text-lg font-semibold mb-4">Active Positions</h2>
                  {positionsLoading ? (
                    <div className="flex h-32 items-center justify-center text-muted-foreground">
                      Loading positions...
                    </div>
                  ) : (
                    <PositionsTable positions={positions} onClose={handleClosePosition} />
                  )}
                </div>
                
                {/* Pending Trades */}
                <div>
                  <h2 className="text-lg font-semibold mb-4">Recent Trades</h2>
                  {tradesLoading ? (
                    <div className="flex h-32 items-center justify-center text-muted-foreground">
                      Loading trades...
                    </div>
                  ) : (
                    <TradesTable 
                      trades={trades.slice(0, 10)} 
                      onCancel={handleCancelTrade} 
                    />
                  )}
                </div>
              </div>
              
              <div>
                <QuickTrade />
              </div>
            </div>
          </TabsContent>
          
          <TabsContent value="history">
            <div>
              <h2 className="text-lg font-semibold mb-4">All Trades</h2>
              {tradesLoading ? (
                <div className="flex h-32 items-center justify-center text-muted-foreground">
                  Loading trades...
                </div>
              ) : (
                <TradesTable trades={trades} onCancel={handleCancelTrade} />
              )}
            </div>
          </TabsContent>
          
          <TabsContent value="channels">
            <ChannelsManager />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
