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
import {
  Request,
  Response,
  type SettingsResponse,
} from "./proto/zmk/perf/perf";
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

function StepInput({
  id,
  value,
  min,
  max,
  smallStep,
  largeStep,
  presets,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  smallStep: number;
  largeStep: number;
  presets: number[];
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const adj = (delta: number) => () => onChange(clamp(value + delta));

  return (
    <div className="step-input">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(clamp(parseInt(e.target.value, 10)))}
        className="step-slider"
      />
      <div className="step-row">
        <button
          type="button"
          className="step-btn"
          onClick={adj(-largeStep)}
          disabled={disabled}
        >
          −{largeStep}
        </button>
        <button
          type="button"
          className="step-btn"
          onClick={adj(-smallStep)}
          disabled={disabled}
        >
          −{smallStep}
        </button>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v)) onChange(clamp(v));
          }}
          className="step-number-input"
        />
        <button
          type="button"
          className="step-btn"
          onClick={adj(smallStep)}
          disabled={disabled}
        >
          +{smallStep}
        </button>
        <button
          type="button"
          className="step-btn"
          onClick={adj(largeStep)}
          disabled={disabled}
        >
          +{largeStep}
        </button>
      </div>
      <div className="step-presets">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className={`preset-btn${value === p ? " preset-active" : ""}`}
            disabled={disabled || p > max}
            onClick={() => onChange(clamp(p))}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

const THROUGHPUT_WINDOW_MS = 3000;
const LATENCY_HISTORY_MS = 60_000;
const DEFAULT_DATA_SIZE_MAX = 2048;

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

function formatBytes(value: number | undefined): string {
  if (value === undefined || value === 0) return "—";
  if (value >= 1024) return `${value} B (${(value / 1024).toFixed(1)} KiB)`;
  return `${value} B`;
}

function encodedPerfRequestLength(
  dataSize: number,
  responseSize: number,
  split: boolean
): number {
  return Request.encode(
    Request.create({
      perf: {
        sequenceNumber: 1,
        responseSize,
        data: new Uint8Array(dataSize),
        split,
      },
    })
  ).finish().length;
}

function requestSizeMax(
  settings: SettingsResponse | null,
  responseSize: number,
  split: boolean
) {
  if (!settings) return DEFAULT_DATA_SIZE_MAX;

  let max = settings.perfRequestDataMaxBytes || DEFAULT_DATA_SIZE_MAX;
  if (split && settings.splitRelayRequestDataMaxBytes > 0) {
    max = Math.min(max, settings.splitRelayRequestDataMaxBytes);
  }

  const payloadMax = settings.customSubsystemRequestPayloadMaxBytes;
  if (payloadMax === 0) return max;

  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodedPerfRequestLength(mid, responseSize, split) <= payloadMax) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return lo;
}

function responseSizeMax(settings: SettingsResponse | null, split: boolean) {
  if (!settings) return DEFAULT_DATA_SIZE_MAX;

  let max = settings.perfResponseDataMaxBytes || DEFAULT_DATA_SIZE_MAX;
  if (split && settings.splitRelayResponseDataMaxBytes > 0) {
    max = Math.min(max, settings.splitRelayResponseDataMaxBytes);
  }
  return max;
}

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

export function PerfSection() {
  const zmkApp = useContext(ZMKAppContext);

  const [requestSize, setRequestSize] = useState(1);
  const [responseSize, setResponseSize] = useState(1);
  const [intervalMs, setIntervalMs] = useState(100);
  const [useSplit, setUseSplit] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const statsRef = useRef({ ...INITIAL_STATS });
  const bytesWindowRef = useRef<Array<{ ts: number; bytes: number }>>([]);
  const latencyHistoryRef = useRef<LatencyPoint[]>([]);
  const testStartRef = useRef(0);
  const isRunningRef = useRef(false);
  const serviceRef = useRef<ZMKCustomSubsystem | null>(null);

  const maxResponseSize = responseSizeMax(settings, useSplit);
  const effectiveResponseSize = Math.min(responseSize, maxResponseSize);
  const maxRequestSize = requestSizeMax(
    settings,
    effectiveResponseSize,
    useSplit
  );
  const effectiveRequestSize = Math.min(requestSize, maxRequestSize);

  const updateStats = useCallback(() => {
    setStats({ ...statsRef.current });
    setLatencyHistory([...latencyHistoryRef.current]);
  }, []);

  const stop = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
  }, []);

  const loadSettings = useCallback(async (service: ZMKCustomSubsystem) => {
    try {
      const payload = Request.encode(Request.create({ settings: {} })).finish();
      const raw = await service.callRPC(payload);
      if (!raw) {
        setSettingsError("No settings response");
        return;
      }

      const resp = Response.decode(raw);
      if (resp.settings) {
        setSettings(resp.settings);
      } else if (resp.error) {
        setSettingsError(resp.error.message || "Settings request failed");
      } else {
        setSettingsError("Unexpected settings response");
      }
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Settings request failed"
      );
    }
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

        const data = new Uint8Array(effectiveRequestSize).fill(0x55);
        const payload = Request.encode(
          Request.create({
            perf: {
              sequenceNumber: seq,
              responseSize: effectiveResponseSize,
              data,
              split: useSplit,
            },
          })
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
                  ? (bytesWindowRef.current[bytesWindowRef.current.length - 1]
                      .ts -
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
  }, [
    zmkApp,
    effectiveRequestSize,
    effectiveResponseSize,
    intervalMs,
    useSplit,
    updateStats,
  ]);

  // Keep serviceRef in sync when the connection changes
  useEffect(() => {
    if (!zmkApp) return;
    const subsystem = zmkApp.findSubsystem(SUBSYSTEM_IDENTIFIER);
    if (!zmkApp.state.connection || !subsystem) {
      serviceRef.current = null;
      return;
    }
    const service = new ZMKCustomSubsystem(
      zmkApp.state.connection,
      subsystem.index
    );
    serviceRef.current = service;
    const timeoutId = window.setTimeout(() => {
      loadSettings(service);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [zmkApp, loadSettings]);

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
          <label htmlFor="target-split">Target:</label>
          <div className="target-toggle">
            <button
              id="target-local"
              type="button"
              className={`target-option${!useSplit ? " target-active" : ""}`}
              disabled={isRunning}
              onClick={() => setUseSplit(false)}
            >
              Local
            </button>
            <button
              id="target-split"
              type="button"
              className={`target-option${useSplit ? " target-active" : ""}`}
              disabled={isRunning}
              onClick={() => setUseSplit(true)}
            >
              Split
            </button>
          </div>
        </div>

        <div className="input-group">
          <label htmlFor="req-size">Request size (bytes):</label>
          <StepInput
            id="req-size"
            value={effectiveRequestSize}
            min={0}
            max={maxRequestSize}
            smallStep={1}
            largeStep={32}
            presets={[0, 32, 64, 128, 256, 512, 1024, 2048]}
            disabled={isRunning}
            onChange={setRequestSize}
          />
        </div>

        <div className="input-group">
          <label htmlFor="resp-size">Response size (bytes):</label>
          <StepInput
            id="resp-size"
            value={effectiveResponseSize}
            min={0}
            max={maxResponseSize}
            smallStep={1}
            largeStep={32}
            presets={[0, 32, 64, 128, 256, 512, 1024, 2048]}
            disabled={isRunning}
            onChange={setResponseSize}
          />
        </div>

        <div className="input-group">
          <label htmlFor="interval">Interval between requests (ms):</label>
          <StepInput
            id="interval"
            value={intervalMs}
            min={0}
            max={10000}
            smallStep={10}
            largeStep={100}
            presets={[0, 100, 500, 1000, 2000]}
            disabled={isRunning}
            onChange={setIntervalMs}
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

      <div className="limits-section">
        <h3>Device Limits</h3>
        {settingsError && <div className="stat-sub">{settingsError}</div>}
        <div className="limits-grid">
          <div className="limit-item">
            <span className="limit-label">RPC RX buffer</span>
            <span className="limit-value">
              {formatBytes(settings?.studioRpcRxBufSize)}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">RPC TX buffer</span>
            <span className="limit-value">
              {formatBytes(settings?.studioRpcTxBufSize)}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">Custom request payload</span>
            <span className="limit-value">
              {formatBytes(settings?.customSubsystemRequestPayloadMaxBytes)}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">Perf request data</span>
            <span className="limit-value">
              {formatBytes(settings?.perfRequestDataMaxBytes)}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">Perf response data</span>
            <span className="limit-value">
              {formatBytes(settings?.perfResponseDataMaxBytes)}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">Split relay payload</span>
            <span className="limit-value">
              {settings?.splitRelayEnabled
                ? formatBytes(settings.splitRelayEventDataLen)
                : "disabled"}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">Split request data</span>
            <span className="limit-value">
              {formatBytes(settings?.splitRelayRequestDataMaxBytes)}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">Split response data</span>
            <span className="limit-value">
              {formatBytes(settings?.splitRelayResponseDataMaxBytes)}
            </span>
          </div>
        </div>
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
