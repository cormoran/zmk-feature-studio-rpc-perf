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

export const SUBSYSTEM_IDENTIFIER = "zmk__perf";

// Sliding-window duration for throughput calculation (ms)
const THROUGHPUT_WINDOW_MS = 3000;

interface PerfStats {
  sent: number;
  received: number;
  latencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  bitsPerSecond: number;
  lossRate: number; // 0-100 %
}

const INITIAL_STATS: PerfStats = {
  sent: 0,
  received: 0,
  latencyMs: null,
  minLatencyMs: null,
  maxLatencyMs: null,
  bitsPerSecond: 0,
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

export function PerfSection() {
  const zmkApp = useContext(ZMKAppContext);

  const [requestSize, setRequestSize] = useState(64);
  const [responseSize, setResponseSize] = useState(64);
  const [intervalMs, setIntervalMs] = useState(500);
  const [isRunning, setIsRunning] = useState(false);
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);

  // Mutable refs to avoid stale-closure issues inside interval callback
  const seqRef = useRef(0);
  const pendingRef = useRef<Map<number, number>>(new Map()); // seq → sentAt
  const statsRef = useRef({ ...INITIAL_STATS });
  // Each entry records {timestamp, bytes} for throughput windowing
  const bytesWindowRef = useRef<Array<{ ts: number; bytes: number }>>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const serviceRef = useRef<ZMKCustomSubsystem | null>(null);

  const updateStats = useCallback(() => {
    setStats({ ...statsRef.current });
  }, []);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRunning(false);
  }, []);

  const start = useCallback(() => {
    if (!zmkApp || !serviceRef.current) return;
    const service = serviceRef.current;

    // Reset state
    seqRef.current = 0;
    pendingRef.current.clear();
    bytesWindowRef.current = [];
    statsRef.current = { ...INITIAL_STATS };
    setStats({ ...INITIAL_STATS });
    setIsRunning(true);

    timerRef.current = setInterval(async () => {
      const seq = ++seqRef.current;
      const sentAt = performance.now();

      // Build request payload
      const data = new Uint8Array(requestSize).fill(0x55);
      const payload = Request.encode(
        Request.create({ perf: { sequenceNumber: seq, responseSize, data } })
      ).finish();

      statsRef.current.sent += 1;
      pendingRef.current.set(seq, sentAt);

      try {
        const raw = await service.callRPC(payload);
        if (!raw) return;

        const resp = Response.decode(raw);
        if (!resp.perf) return;

        const now = performance.now();
        const startTs = pendingRef.current.get(resp.perf.sequenceNumber);
        if (startTs === undefined) return;

        pendingRef.current.delete(resp.perf.sequenceNumber);

        const latency = now - startTs;
        statsRef.current.received += 1;

        // Latency
        statsRef.current.latencyMs = latency;
        statsRef.current.minLatencyMs =
          statsRef.current.minLatencyMs === null
            ? latency
            : Math.min(statsRef.current.minLatencyMs, latency);
        statsRef.current.maxLatencyMs =
          statsRef.current.maxLatencyMs === null
            ? latency
            : Math.max(statsRef.current.maxLatencyMs, latency);

        // Throughput: count request + response bytes in a sliding window
        const transferredBytes = payload.length + raw.length;
        bytesWindowRef.current.push({ ts: now, bytes: transferredBytes });
        // Prune entries older than the window
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
            ? (bytesWindowRef.current[bytesWindowRef.current.length - 1].ts -
                bytesWindowRef.current[0].ts) /
              1000
            : 0; // not enough data points yet
        statsRef.current.bitsPerSecond =
          windowDuration > 0 ? (windowBytes * 8) / windowDuration : 0;

        // Loss rate
        statsRef.current.lossRate =
          statsRef.current.sent > 0
            ? ((statsRef.current.sent - statsRef.current.received) /
                statsRef.current.sent) *
              100
            : 0;
      } catch {
        // Errors (e.g. timeout, disconnected) are intentionally ignored here;
        // the sent/received counter mismatch already reflects the loss rate.
      }

      updateStats();
    }, intervalMs);
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
          <label htmlFor="interval">Send interval (ms):</label>
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
            setStats({ ...INITIAL_STATS });
          }}
        >
          🔄 Reset
        </button>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Ping latency</div>
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
          <div className="stat-label">Throughput</div>
          <div className="stat-value">
            {stats.bitsPerSecond >= 1000
              ? `${(stats.bitsPerSecond / 1000).toFixed(1)} kbps`
              : `${stats.bitsPerSecond.toFixed(0)} bps`}
          </div>
          <div className="stat-sub">bits per second (request + response)</div>
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
