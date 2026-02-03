import { useMemo } from 'react'

/**
 * Sparkline component
 * props:
 *  - data: number[]
 *  - width: number (default 300)
 *  - height: number (default 40)
 *  - color: stroke color (default #51a4ff)
 *  - fill: optional area fill color (rgba)
 *  - min / max: optional fixed bounds; otherwise auto with padding
 */
export default function Sparkline({ data, width=300, height=40, color='#51a4ff', fill='rgba(81,164,255,0.15)', min, max }) {
  const svg = useMemo(()=>{
    if(!Array.isArray(data) || data.length === 0) return null
    const lo = min != null ? min : Math.min(...data)
    const hi = max != null ? max : Math.max(...data)
    const pad = (hi - lo) === 0 ? 1 : (hi - lo) * 0.05
    const minV = lo - pad
    const maxV = hi + pad
    const normY = (v) => {
      if(maxV - minV === 0) return height/2
      return (1 - (v - minV)/(maxV - minV)) * (height - 6) + 3
    }
    const step = data.length > 1 ? width / (data.length - 1) : width
    const linePath = data.map((v,i)=> `${i===0?'M':'L'} ${i*step} ${normY(v)}`).join(' ')
    const areaPath = `M 0 ${height} ${data.map((v,i)=>`L ${i*step} ${normY(v)}`).join(' ')} L ${width} ${height} Z`
    const mid = (minV + maxV)/2
    return (
      <svg width={width} height={height} className="block">
        {fill && <path d={areaPath} fill={fill} stroke="none" />}
        <path d={linePath} stroke={color} fill="none" strokeWidth={2} />
        {/* midline */}
        <line x1={0} x2={width} y1={normY(mid)} y2={normY(mid)} stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
      </svg>
    )
  }, [data, width, height, color, fill, min, max])
  return svg || <div className="muted text-xs">No data</div>
}
