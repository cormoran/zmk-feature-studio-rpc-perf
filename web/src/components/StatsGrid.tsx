import type { PerfStats } from "../hooks/usePerfTest";

export function StatsGrid({ stats }: { stats: PerfStats }) {
  return (
    <div className="stats-grid">
      <div className="stat-card">
        <div className="stat-label">Last latency</div>
        <div className="stat-value">
          {stats.latencyMs !== null ? `${stats.latencyMs.toFixed(1)} ms` : "—"}
        </div>
        <div className="stat-sub">
          {stats.minLatencyMs !== null && stats.maxLatencyMs !== null
            ? `min ${stats.minLatencyMs.toFixed(1)} / max ${stats.maxLatencyMs.toFixed(1)} ms`
            : ""}
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Avg latency (60s)</div>
        <div className="stat-value">
          {stats.avgLatencyMs !== null
            ? `${stats.avgLatencyMs.toFixed(1)} ms`
            : "—"}
        </div>
        <div className="stat-sub">
          {stats.medianLatencyMs !== null
            ? `median ${stats.medianLatencyMs.toFixed(1)} ms`
            : ""}
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Req/sec (60s)</div>
        <div className="stat-value">
          {stats.rps > 0 ? stats.rps.toFixed(2) : "—"}
        </div>
        <div className="stat-sub">requests per second</div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Throughput</div>
        <div className="stat-value">
          {stats.bitsPerSecond >= 1000
            ? `${(stats.bitsPerSecond / 1000).toFixed(1)} kbps`
            : `${stats.bitsPerSecond.toFixed(0)} bps`}
        </div>
        <div className="stat-sub">bits per second (3s window)</div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Packet loss</div>
        <div className={`stat-value ${stats.lossRate > 5 ? "stat-warn" : ""}`}>
          {stats.lossRate.toFixed(1)} %
        </div>
        <div className="stat-sub">
          {stats.received} / {stats.sent} packets
        </div>
      </div>
    </div>
  );
}
