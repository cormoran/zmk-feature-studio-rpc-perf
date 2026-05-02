/**
 * ZMK Studio RPC Performance Measurement
 *
 * Measures round-trip latency, throughput (bits/s) and packet-loss rate
 * of the ZMK Studio custom RPC protocol over USB (serial) or BLE.
 */

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import "./App.css";
import { connect as serial_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/serial";
import { connect as ble_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/gatt";
import {
  ZMKConnection,
  ZMKCustomSubsystem,
  ZMKAppContext,
} from "@cormoran/zmk-studio-react-hook";
import { Request, Response } from "./proto/zmk/perf/perf";
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

export const SUBSYSTEM_IDENTIFIER = "zmk__perf";

const THROUGHPUT_WINDOW_MS = 3000;
const LATENCY_HISTORY_MS = 60_000;

interface LatencyPoint {
  elapsedS: number;
  latencyMs: number;
}

interface PerfStats {
  sent: number;
  received: number;
  latencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  avgLatencyMs: number | null;
  medianLatencyMs: number | null;
  bitsPerSecond: number;
  rps: number;
  lossRate: number;
}

const INITIAL_STATS: PerfStats = {
  sent: 0,
  received: 0,
  latencyMs: null,
  minLatencyMs: null,
  maxLatencyMs: null,
  avgLatencyMs: null,
  medianLatencyMs: null,
  bitsPerSecond: 0,
  rps: 0,
  lossRate: 0,
};

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>📡 ZMK Studio RPC Performance</h1>
        <p>Measure latency, throughput and packet-loss over USB or BLE</p>
      </header>

      <ZMKConnection
        renderDisconnected={({ connect, isLoading, error }) => (
          <section className="card">
            <h2>Device Connection</h2>
            {isLoading && <p>⏳ Connecting…</p>}
            {error && (
              <div className="error-message">
                <p>🚨 {error}</p>
              </div>
            )}
            {!isLoading && (
              <div className="button-group">
                <button
                  className="btn btn-primary"
                  onClick={() => connect(serial_connect)}
                >
                  🔌 Connect USB
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => connect(ble_connect)}
                >
                  📶 Connect BLE
                </button>
              </div>
            )}
          </section>
        )}
        renderConnected={({ disconnect, deviceName }) => (
          <>
            <section className="card">
              <h2>Device Connection</h2>
              <div className="device-info">
                <h3>✅ Connected to: {deviceName}</h3>
              </div>
              <button className="btn btn-secondary" onClick={disconnect}>
                Disconnect
              </button>
            </section>

            <PerfSection />
          </>
        )}
      />

      <footer className="app-footer">
        <p>
          <strong>ZMK Studio RPC Performance</strong> – custom RPC perf module
        </p>
      </footer>
    </div>
  );
}

function LatencyGraph({
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
        <YAxis unit="ms" width={65} tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
        <Tooltip
          formatter={(val: number) => [`${val.toFixed(1)} ms`, "Latency"]}
          labelFormatter={(v) => `${Number(v).toFixed(1)}s`}
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

export function PerfSection() {
  const zmkApp = useContext(ZMKAppContext);

  const [requestSize, setRequestSize] = useState(64);
  const [responseSize, setResponseSize] = useState(64);
  const [intervalMs, setIntervalMs] = useState(500);
  const [isRunning, setIsRunning] = useState(false);
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);

  const seqRef = useRef(0);
  const statsRef = useRef({ ...INITIAL_STATS });
  const bytesWindowRef = useRef<Array<{ ts: number; bytes: number }>>([]);
  const latencyHistoryRef = useRef<LatencyPoint[]>([]);
  const testStartRef = useRef(0);
  const isRunningRef = useRef(false);
  const serviceRef = useRef<ZMKCustomSubsystem | null>(null);

  const updateStats = useCallback(() => {
    setStats({ ...statsRef.current });
    setLatencyHistory([...latencyHistoryRef.current]);
  }, []);

  const stop = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
  }, []);

  const start = useCallback(() => {
    if (!zmkApp || !serviceRef.current) return;
    const service = serviceRef.current;

    seqRef.current = 0;
    bytesWindowRef.current = [];
    latencyHistoryRef.current = [];
    statsRef.current = { ...INITIAL_STATS };
    setStats({ ...INITIAL_STATS });
    setLatencyHistory([]);
    testStartRef.current = performance.now();
    isRunningRef.current = true;
    setIsRunning(true);

    const runLoop = async () => {
      while (isRunningRef.current) {
        const seq = ++seqRef.current;
        const sentAt = performance.now();

        const data = new Uint8Array(requestSize).fill(0x55);
        const payload = Request.encode(
          Request.create({ perf: { sequenceNumber: seq, responseSize, data } })
        ).finish();

        statsRef.current.sent += 1;

        try {
          // Await response before sending next request — avoids firmware mutex contention.
          const raw = await service.callRPC(payload);
          if (raw) {
            const resp = Response.decode(raw);
            if (resp.perf) {
              const now = performance.now();
              const latency = now - sentAt;
              statsRef.current.received += 1;

              statsRef.current.latencyMs = latency;
              statsRef.current.minLatencyMs =
                statsRef.current.minLatencyMs === null
                  ? latency
                  : Math.min(statsRef.current.minLatencyMs, latency);
              statsRef.current.maxLatencyMs =
                statsRef.current.maxLatencyMs === null
                  ? latency
                  : Math.max(statsRef.current.maxLatencyMs, latency);

              // Latency history (1 min sliding window)
              const elapsedS = (now - testStartRef.current) / 1000;
              latencyHistoryRef.current.push({ elapsedS, latencyMs: latency });
              const historyCutoffS = elapsedS - LATENCY_HISTORY_MS / 1000;
              latencyHistoryRef.current = latencyHistoryRef.current.filter(
                (e) => e.elapsedS >= historyCutoffS
              );

              // Avg and median from history window
              const windowLatencies = latencyHistoryRef.current.map(
                (e) => e.latencyMs
              );
              const sum = windowLatencies.reduce((a, b) => a + b, 0);
              statsRef.current.avgLatencyMs = sum / windowLatencies.length;
              const sorted = [...windowLatencies].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              statsRef.current.medianLatencyMs =
                sorted.length % 2 === 0
                  ? (sorted[mid - 1] + sorted[mid]) / 2
                  : sorted[mid];

              // RPS from history window
              const hist = latencyHistoryRef.current;
              const histDuration =
                hist.length > 1
                  ? hist[hist.length - 1].elapsedS - hist[0].elapsedS
                  : 0;
              statsRef.current.rps =
                histDuration > 0 ? (hist.length - 1) / histDuration : 0;

              // Throughput: 3s sliding window
              const transferredBytes = payload.length + raw.length;
              bytesWindowRef.current.push({ ts: now, bytes: transferredBytes });
              const cutoff = now - THROUGHPUT_WINDOW_MS;
              bytesWindowRef.current = bytesWindowRef.current.filter(
                (e) => e.ts >= cutoff
              );
              const windowBytes = bytesWindowRef.current.reduce(
                (acc, e) => acc + e.bytes,
                0
              );
              const windowDuration =
                bytesWindowRef.current.length > 1
                  ? (bytesWindowRef.current[
                      bytesWindowRef.current.length - 1
                    ].ts -
                      bytesWindowRef.current[0].ts) /
                    1000
                  : 0;
              statsRef.current.bitsPerSecond =
                windowDuration > 0 ? (windowBytes * 8) / windowDuration : 0;

              statsRef.current.lossRate =
                statsRef.current.sent > 0
                  ? ((statsRef.current.sent - statsRef.current.received) /
                      statsRef.current.sent) *
                    100
                  : 0;
            }
          }
        } catch {
          // sent/received counter mismatch already reflects loss rate
        }

        updateStats();

        const elapsed = performance.now() - sentAt;
        const remaining = intervalMs - elapsed;
        if (isRunningRef.current && remaining > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        }
      }
    };

    runLoop();
  }, [zmkApp, requestSize, responseSize, intervalMs, updateStats]);

  // Keep serviceRef in sync when the connection changes
  useEffect(() => {
    if (!zmkApp) return;
    const subsystem = zmkApp.findSubsystem(SUBSYSTEM_IDENTIFIER);
    if (!zmkApp.state.connection || !subsystem) {
      serviceRef.current = null;
      return;
    }
    serviceRef.current = new ZMKCustomSubsystem(
      zmkApp.state.connection,
      subsystem.index
    );
  }, [zmkApp]);

  // Stop on unmount
  useEffect(() => () => stop(), [stop]);

  if (!zmkApp) return null;

  const subsystem = zmkApp.findSubsystem(SUBSYSTEM_IDENTIFIER);

  if (!subsystem) {
    return (
      <section className="card">
        <div className="warning-message">
          <p>
            ⚠️ Subsystem "{SUBSYSTEM_IDENTIFIER}" not found. Make sure your
            firmware includes the perf module (
            <code>CONFIG_ZMK_STUDIO_RPC_PERF=y</code> and{" "}
            <code>CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER=y</code>).
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>⚡ Performance Test</h2>

      <div className="perf-controls">
        <div className="input-group">
          <label htmlFor="req-size">Request size (bytes):</label>
          <input
            id="req-size"
            type="number"
            min={0}
            max={256}
            value={requestSize}
            disabled={isRunning}
            onChange={(e) =>
              setRequestSize(
                Math.min(256, Math.max(0, parseInt(e.target.value) || 0))
              )
            }
          />
        </div>

        <div className="input-group">
          <label htmlFor="resp-size">Response size (bytes):</label>
          <input
            id="resp-size"
            type="number"
            min={0}
            max={256}
            value={responseSize}
            disabled={isRunning}
            onChange={(e) =>
              setResponseSize(
                Math.min(256, Math.max(0, parseInt(e.target.value) || 0))
              )
            }
          />
        </div>

        <div className="input-group">
          <label htmlFor="interval">Interval between requests (ms):</label>
          <input
            id="interval"
            type="number"
            min={1}
            max={10000}
            value={intervalMs}
            disabled={isRunning}
            onChange={(e) =>
              setIntervalMs(Math.max(1, parseInt(e.target.value) || 500))
            }
          />
        </div>
      </div>

      <div className="button-group">
        {isRunning ? (
          <button className="btn btn-secondary" onClick={stop}>
            ⏹ Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={start}>
            ▶ Start
          </button>
        )}
        <button
          className="btn btn-secondary"
          disabled={isRunning}
          onClick={() => {
            statsRef.current = { ...INITIAL_STATS };
            bytesWindowRef.current = [];
            latencyHistoryRef.current = [];
            setStats({ ...INITIAL_STATS });
            setLatencyHistory([]);
          }}
        >
          🔄 Reset
        </button>
      </div>

      <div className="graph-section">
        <h3>Latency over time (last 60s)</h3>
        <LatencyGraph
          history={latencyHistory}
          avgLatencyMs={stats.avgLatencyMs}
          medianLatencyMs={stats.medianLatencyMs}
        />
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Last latency</div>
          <div className="stat-value">
            {stats.latencyMs !== null
              ? `${stats.latencyMs.toFixed(1)} ms`
              : "—"}
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
          <div
            className={`stat-value ${stats.lossRate > 5 ? "stat-warn" : ""}`}
          >
            {stats.lossRate.toFixed(1)} %
          </div>
          <div className="stat-sub">
            {stats.received} / {stats.sent} packets
          </div>
        </div>
      </div>
    </section>
  );
}

export default App;
