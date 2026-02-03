import { useMemo } from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: string;
  min?: number;
  max?: number;
}

export function Sparkline({ 
  data, 
  width = 300, 
  height = 40, 
  color = '#3b82f6', 
  fill = 'rgba(59,130,246,0.15)', 
  min, 
  max 
}: SparklineProps) {
  const svg = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return null;
    
    const lo = min != null ? min : Math.min(...data);
    const hi = max != null ? max : Math.max(...data);
    const pad = (hi - lo) === 0 ? 1 : (hi - lo) * 0.05;
    const minV = lo - pad;
    const maxV = hi + pad;
    
    const normY = (v: number) => {
      if (maxV - minV === 0) return height / 2;
      return (1 - (v - minV) / (maxV - minV)) * (height - 6) + 3;
    };
    
    const step = data.length > 1 ? width / (data.length - 1) : width;
    const linePath = data.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${normY(v)}`).join(' ');
    const areaPath = `M 0 ${height} ${data.map((v, i) => `L ${i * step} ${normY(v)}`).join(' ')} L ${width} ${height} Z`;
    const mid = (minV + maxV) / 2;
    
    return (
      <svg width={width} height={height} className="block">
        {fill && <path d={areaPath} fill={fill} stroke="none" />}
        <path d={linePath} stroke={color} fill="none" strokeWidth={2} />
        <line 
          x1={0} 
          x2={width} 
          y1={normY(mid)} 
          y2={normY(mid)} 
          stroke="rgba(255,255,255,0.08)" 
          strokeDasharray="4 4" 
        />
      </svg>
    );
  }, [data, width, height, color, fill, min, max]);
  
  return svg || <div className="text-xs text-muted-foreground">No data</div>;
}
