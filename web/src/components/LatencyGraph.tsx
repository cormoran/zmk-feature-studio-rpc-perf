import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export interface LatencyPoint {
  elapsedS: number;
  latencyMs: number;
}

export function LatencyGraph({
  history,
  avgLatencyMs,
  medianLatencyMs,
}: {
  history: LatencyPoint[];
  avgLatencyMs: number | null;
  medianLatencyMs: number | null;
}) {
  if (history.length === 0) {
    return (
      <div className="graph-empty">
        No data yet — start the test to see latency over time.
      </div>
    );
  }

  const latest = history[history.length - 1].elapsedS;
  const xMin = Math.max(0, latest - 60);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart
        data={history}
        margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
        <XAxis
          dataKey="elapsedS"
          type="number"
          domain={[xMin, latest]}
          tickFormatter={(v: number) => `${v.toFixed(0)}s`}
          tick={{ fontSize: 11 }}
        />
        <YAxis
          unit="ms"
          width={65}
          tick={{ fontSize: 11 }}
          domain={["auto", "auto"]}
        />
        <Tooltip
          formatter={(val: unknown) => [
            `${Number(val).toFixed(1)} ms`,
            "Latency",
          ]}
          labelFormatter={(v: unknown) => `${Number(v).toFixed(1)}s`}
        />
        <Line
          type="monotone"
          dataKey="latencyMs"
          stroke="#4a90d9"
          dot={false}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
        {avgLatencyMs !== null && (
          <ReferenceLine
            y={avgLatencyMs}
            stroke="#f97316"
            strokeDasharray="4 2"
            label={{
              value: `avg ${avgLatencyMs.toFixed(1)}ms`,
              fill: "#f97316",
              fontSize: 11,
              position: "insideTopRight",
            }}
          />
        )}
        {medianLatencyMs !== null && (
          <ReferenceLine
            y={medianLatencyMs}
            stroke="#22c55e"
            strokeDasharray="4 2"
            label={{
              value: `med ${medianLatencyMs.toFixed(1)}ms`,
              fill: "#22c55e",
              fontSize: 11,
              position: "insideBottomRight",
            }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
