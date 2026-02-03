import { useMemo } from 'react';

interface PnLItem {
  id: string;
  name: string;
  value: number;
}

interface PnLMapProps {
  items: PnLItem[];
}

export function PnLMap({ items }: PnLMapProps) {
  const data = Array.isArray(items) ? items : [];
  
  const { maxAbs, positive, negative } = useMemo(() => {
    if (!data.length) return { maxAbs: 1, positive: [], negative: [] };
    const vals = data.map(d => d.value || 0);
    const maxAbs = Math.max(1, ...vals.map(v => Math.abs(v)));
    return {
      maxAbs,
      positive: data.filter(d => (d.value || 0) >= 0).sort((a, b) => (b.value || 0) - (a.value || 0)),
      negative: data.filter(d => (d.value || 0) < 0).sort((a, b) => (a.value || 0) - (b.value || 0))
    };
  }, [data]);

  if (!data.length) return <div className="text-xs text-muted-foreground">No tracker PnL yet</div>;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-muted-foreground mb-1">Positive</div>
        <div className="space-y-1">
          {positive.map(d => {
            const w = Math.min(100, (Math.abs(d.value || 0) / maxAbs) * 100);
            return (
              <div key={d.id} className="flex items-center gap-2 text-xs">
                <div className="w-32 truncate" title={d.name}>{d.name}</div>
                <div className="flex-1 h-3 bg-emerald-900/30 rounded overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${w}%` }} />
                </div>
                <div className="w-20 text-right tabular-nums">{d.value.toFixed(6)}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground mb-1">Negative</div>
        <div className="space-y-1">
          {negative.map(d => {
            const w = Math.min(100, (Math.abs(d.value || 0) / maxAbs) * 100);
            return (
              <div key={d.id} className="flex items-center gap-2 text-xs">
                <div className="w-32 truncate" title={d.name}>{d.name}</div>
                <div className="flex-1 h-3 bg-rose-900/30 rounded overflow-hidden">
                  <div className="h-full bg-rose-500" style={{ width: `${w}%` }} />
                </div>
                <div className="w-20 text-right tabular-nums">{d.value.toFixed(6)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
