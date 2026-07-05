import {
  SWEEP_SIZE_PRESETS,
  type SweepDimension,
  type SweepStepResult,
} from "../hooks/useBenchmarkSweep";
import {
  buildSweepCsv,
  buildSweepJson,
  downloadTextFile,
} from "../lib/sweepExport";
import type { SettingsResponse } from "../proto/zmk/perf/perf";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const DIMENSION_LABELS: Record<SweepDimension, string> = {
  request: "Request size",
  response: "Response size",
  both: "Both (symmetric)",
};

export function SweepPanel({
  deviceName,
  settings,
  dimension,
  setDimension,
  selectedSizes,
  setSelectedSizes,
  requestsPerStep,
  setRequestsPerStep,
  fixedRequestSize,
  setFixedRequestSize,
  fixedResponseSize,
  setFixedResponseSize,
  useSplit,
  setUseSplit,
  isSweeping,
  results,
  skippedCount,
  start,
  stop,
}: {
  deviceName: string;
  settings: SettingsResponse | null;
  dimension: SweepDimension;
  setDimension: (d: SweepDimension) => void;
  selectedSizes: number[];
  setSelectedSizes: (sizes: number[]) => void;
  requestsPerStep: number;
  setRequestsPerStep: (n: number) => void;
  fixedRequestSize: number;
  setFixedRequestSize: (n: number) => void;
  fixedResponseSize: number;
  setFixedResponseSize: (n: number) => void;
  useSplit: boolean;
  setUseSplit: (v: boolean) => void;
  isSweeping: boolean;
  results: SweepStepResult[];
  skippedCount: number;
  start: () => void;
  stop: () => void;
}) {
  const toggleSize = (size: number) => {
    setSelectedSizes(
      selectedSizes.includes(size)
        ? selectedSizes.filter((s) => s !== size)
        : [...selectedSizes, size]
    );
  };

  const exportMetadata = {
    deviceName,
    target: useSplit ? ("split" as const) : ("local" as const),
    timestamp: new Date().toISOString(),
    settings,
  };

  return (
    <div className="sweep-panel">
      <div className="perf-controls">
        <div className="input-group">
          <label htmlFor="sweep-dimension">Sweep dimension:</label>
          <div className="target-toggle dimension-toggle">
            {(Object.keys(DIMENSION_LABELS) as SweepDimension[]).map((d) => (
              <button
                key={d}
                type="button"
                id={`sweep-dimension-${d}`}
                className={`target-option${dimension === d ? " target-active" : ""}`}
                disabled={isSweeping}
                onClick={() => setDimension(d)}
              >
                {DIMENSION_LABELS[d]}
              </button>
            ))}
          </div>
        </div>

        <div className="input-group">
          <label htmlFor="sweep-target-split">Target:</label>
          <div className="target-toggle">
            <button
              id="sweep-target-local"
              type="button"
              className={`target-option${!useSplit ? " target-active" : ""}`}
              disabled={isSweeping}
              onClick={() => setUseSplit(false)}
            >
              Local
            </button>
            <button
              id="sweep-target-split"
              type="button"
              className={`target-option${useSplit ? " target-active" : ""}`}
              disabled={isSweeping}
              onClick={() => setUseSplit(true)}
            >
              Split
            </button>
          </div>
        </div>

        <div className="input-group">
          <label htmlFor="sweep-request-count">Requests per size:</label>
          <input
            id="sweep-request-count"
            type="number"
            min={1}
            max={1000}
            value={requestsPerStep}
            disabled={isSweeping}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v > 0) setRequestsPerStep(v);
            }}
            className="step-number-input"
          />
        </div>

        {dimension !== "request" && (
          <div className="input-group">
            <label htmlFor="sweep-fixed-request">
              Fixed request size (bytes):
            </label>
            <input
              id="sweep-fixed-request"
              type="number"
              min={0}
              value={fixedRequestSize}
              disabled={isSweeping}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0) setFixedRequestSize(v);
              }}
              className="step-number-input"
            />
          </div>
        )}

        {dimension !== "response" && (
          <div className="input-group">
            <label htmlFor="sweep-fixed-response">
              Fixed response size (bytes):
            </label>
            <input
              id="sweep-fixed-response"
              type="number"
              min={0}
              value={fixedResponseSize}
              disabled={isSweeping}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0) setFixedResponseSize(v);
              }}
              className="step-number-input"
            />
          </div>
        )}
      </div>

      <div className="input-group">
        <label>Sizes to test (bytes):</label>
        <div className="size-checkbox-group">
          {SWEEP_SIZE_PRESETS.map((size) => (
            <label key={size} className="size-checkbox">
              <input
                type="checkbox"
                checked={selectedSizes.includes(size)}
                disabled={isSweeping}
                onChange={() => toggleSize(size)}
              />
              {size}
            </label>
          ))}
        </div>
      </div>

      <div className="button-group">
        {isSweeping ? (
          <button className="btn btn-secondary" onClick={stop}>
            ⏹ Stop sweep
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={selectedSizes.length === 0}
            onClick={start}
          >
            ▶ Start sweep
          </button>
        )}
        <button
          className="btn btn-secondary"
          disabled={results.length === 0}
          onClick={() =>
            downloadTextFile(
              `perf-sweep-${exportMetadata.timestamp}.csv`,
              buildSweepCsv(results, exportMetadata),
              "text/csv"
            )
          }
        >
          ⬇ Download CSV
        </button>
        <button
          className="btn btn-secondary"
          disabled={results.length === 0}
          onClick={() =>
            downloadTextFile(
              `perf-sweep-${exportMetadata.timestamp}.json`,
              buildSweepJson(results, exportMetadata),
              "application/json"
            )
          }
        >
          ⬇ Download JSON
        </button>
      </div>

      {skippedCount > 0 && (
        <p className="stat-sub">
          {skippedCount} selected size(s) collapsed onto an already-tested size
          after clamping to the device limits and were skipped.
        </p>
      )}

      {results.length === 0 ? (
        <div className="graph-empty">
          No sweep data yet — start a sweep to see results per size.
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={results}
              margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
              <XAxis
                dataKey={
                  dimension === "response" ? "responseSize" : "requestSize"
                }
                tick={{ fontSize: 11 }}
              />
              <YAxis
                yAxisId="latency"
                unit="ms"
                width={65}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                yAxisId="throughput"
                orientation="right"
                unit="bps"
                width={70}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              <Line
                yAxisId="latency"
                type="monotone"
                dataKey="avgLatencyMs"
                name="Avg latency (ms)"
                stroke="#4a90d9"
                dot
                isAnimationActive={false}
              />
              <Line
                yAxisId="throughput"
                type="monotone"
                dataKey="bitsPerSecond"
                name="Throughput (bps)"
                stroke="#22c55e"
                dot
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>

          <div className="sweep-table-wrapper">
            <table className="sweep-table">
              <thead>
                <tr>
                  <th>Req (B)</th>
                  <th>Resp (B)</th>
                  <th>Sent</th>
                  <th>Recv</th>
                  <th>Errors</th>
                  <th>Loss %</th>
                  <th>Min (ms)</th>
                  <th>Avg (ms)</th>
                  <th>Median (ms)</th>
                  <th>Max (ms)</th>
                  <th>Throughput</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td>{r.requestSize}</td>
                    <td>{r.responseSize}</td>
                    <td>{r.sent}</td>
                    <td>{r.received}</td>
                    <td>{r.errors}</td>
                    <td>{r.lossRate.toFixed(1)}</td>
                    <td>{r.minLatencyMs?.toFixed(1) ?? "—"}</td>
                    <td>{r.avgLatencyMs?.toFixed(1) ?? "—"}</td>
                    <td>{r.medianLatencyMs?.toFixed(1) ?? "—"}</td>
                    <td>{r.maxLatencyMs?.toFixed(1) ?? "—"}</td>
                    <td>
                      {r.bitsPerSecond >= 1000
                        ? `${(r.bitsPerSecond / 1000).toFixed(1)} kbps`
                        : `${r.bitsPerSecond.toFixed(0)} bps`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
