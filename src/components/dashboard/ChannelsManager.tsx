import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useChannels, useCreateChannel, useUpdateChannel, useDeleteChannel, type Channel } from "@/hooks/useChannels";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Settings, Radio } from "lucide-react";
import type { Database } from "@/integrations/supabase/types";

type ChannelCategory = Database["public"]["Enums"]["channel_category"];
type ChainType = Database["public"]["Enums"]["chain_type"];

const categoryLabels: Record<ChannelCategory, string> = {
  alpha_calls: "Alpha Calls",
  whale_tracking: "Whale Tracking",
  insider_alerts: "Insider Alerts",
  degen_plays: "Degen Plays",
  verified_callers: "Verified Callers",
  custom: "Custom",
};

export function ChannelsManager() {
  const { data: channels, isLoading } = useChannels();
  const createChannel = useCreateChannel();
  const updateChannel = useUpdateChannel();
  const deleteChannel = useDeleteChannel();
  const { toast } = useToast();
  
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newChannel, setNewChannel] = useState({
    name: "",
    channel_id: "",
    platform: "telegram",
    category: "alpha_calls" as ChannelCategory,
    chain: "solana" as ChainType,
    allocation_sol: "0.1",
    take_profit_pct: "100",
    stop_loss_pct: "-50",
  });
  
  const handleCreate = async () => {
    try {
      await createChannel.mutateAsync({
        name: newChannel.name,
        channel_id: newChannel.channel_id,
        platform: newChannel.platform,
        category: newChannel.category,
        chain: newChannel.chain,
        allocation_sol: parseFloat(newChannel.allocation_sol),
        take_profit_pct: parseFloat(newChannel.take_profit_pct),
        stop_loss_pct: parseFloat(newChannel.stop_loss_pct),
        enabled: true,
        auto_buy: false,
      });
      
      toast({ title: "Channel added successfully" });
      setIsAddOpen(false);
      setNewChannel({
        name: "",
        channel_id: "",
        platform: "telegram",
        category: "alpha_calls",
        chain: "solana",
        allocation_sol: "0.1",
        take_profit_pct: "100",
        stop_loss_pct: "-50",
      });
    } catch (error) {
      toast({ title: "Failed to add channel", variant: "destructive" });
    }
  };
  
  const handleToggle = async (channel: Channel, field: "enabled" | "auto_buy") => {
    try {
      await updateChannel.mutateAsync({
        id: channel.id,
        [field]: !channel[field],
      });
    } catch (error) {
      toast({ title: "Failed to update channel", variant: "destructive" });
    }
  };
  
  const handleDelete = async (id: string) => {
    try {
      await deleteChannel.mutateAsync(id);
      toast({ title: "Channel deleted" });
    } catch (error) {
      toast({ title: "Failed to delete channel", variant: "destructive" });
    }
  };
  
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-5 w-5" />
          Signal Channels
        </CardTitle>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add Channel
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Signal Channel</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Channel Name</Label>
                  <Input
                    value={newChannel.name}
                    onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })}
                    placeholder="Alpha Group"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Channel ID</Label>
                  <Input
                    value={newChannel.channel_id}
                    onChange={(e) => setNewChannel({ ...newChannel, channel_id: e.target.value })}
                    placeholder="-1001234567890"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Platform</Label>
                  <Select 
                    value={newChannel.platform} 
                    onValueChange={(v) => setNewChannel({ ...newChannel, platform: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="telegram">Telegram</SelectItem>
                      <SelectItem value="discord">Discord</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select 
                    value={newChannel.category} 
                    onValueChange={(v) => setNewChannel({ ...newChannel, category: v as ChannelCategory })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(categoryLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Chain</Label>
                  <Select 
                    value={newChannel.chain} 
                    onValueChange={(v) => setNewChannel({ ...newChannel, chain: v as ChainType })}
                  >
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
                  <Label>Allocation (SOL)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newChannel.allocation_sol}
                    onChange={(e) => setNewChannel({ ...newChannel, allocation_sol: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>TP / SL (%)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="TP"
                      value={newChannel.take_profit_pct}
                      onChange={(e) => setNewChannel({ ...newChannel, take_profit_pct: e.target.value })}
                    />
                    <Input
                      type="number"
                      placeholder="SL"
                      value={newChannel.stop_loss_pct}
                      onChange={(e) => setNewChannel({ ...newChannel, stop_loss_pct: e.target.value })}
                    />
                  </div>
                </div>
              </div>
              
              <Button onClick={handleCreate} className="w-full" disabled={createChannel.isPending}>
                Add Channel
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            Loading channels...
          </div>
        ) : !channels?.length ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            No channels configured
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Chain</TableHead>
                  <TableHead className="text-center">Enabled</TableHead>
                  <TableHead className="text-center">Auto-Buy</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((channel) => (
                  <TableRow key={channel.id}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{channel.name}</div>
                        <div className="text-xs text-muted-foreground">{channel.platform}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {categoryLabels[channel.category]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {channel.chain}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={channel.enabled}
                        onCheckedChange={() => handleToggle(channel, "enabled")}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={channel.auto_buy}
                        onCheckedChange={() => handleToggle(channel, "auto_buy")}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(channel.id)}
                        className="h-8 w-8 text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
