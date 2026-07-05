/**
 * ZMK Studio RPC Performance Measurement
 *
 * Measures round-trip latency, throughput (bits/s) and packet-loss rate
 * of the ZMK Studio custom RPC protocol over USB (serial) or BLE.
 */

import { useContext } from "react";
import "./App.css";
import { connect as serial_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/serial";
import { connect as ble_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/gatt";
import { ZMKConnection, ZMKAppContext } from "@cormoran/zmk-studio-react-hook";
import { usePerfTest } from "./hooks/usePerfTest";
import { PerfControls } from "./components/PerfControls";
import { DeviceLimits } from "./components/DeviceLimits";
import { StatsGrid } from "./components/StatsGrid";
import { LatencyGraph } from "./components/LatencyGraph";

export const SUBSYSTEM_IDENTIFIER = "zmk__perf";

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
  const subsystem = zmkApp?.findSubsystem(SUBSYSTEM_IDENTIFIER) ?? null;
  const connection = zmkApp?.state.connection ?? null;
  const subsystemIndex = subsystem?.index;

  const perf = usePerfTest({ connection, subsystemIndex });

  if (!zmkApp) return null;

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

      <PerfControls
        useSplit={perf.useSplit}
        setUseSplit={perf.setUseSplit}
        isRunning={perf.isRunning}
        requestSize={perf.effectiveRequestSize}
        maxRequestSize={perf.maxRequestSize}
        setRequestSize={perf.setRequestSize}
        responseSize={perf.effectiveResponseSize}
        maxResponseSize={perf.maxResponseSize}
        setResponseSize={perf.setResponseSize}
        intervalMs={perf.intervalMs}
        setIntervalMs={perf.setIntervalMs}
      />

      <div className="button-group">
        {perf.isRunning ? (
          <button className="btn btn-secondary" onClick={perf.stop}>
            ⏹ Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={perf.start}>
            ▶ Start
          </button>
        )}
        <button
          className="btn btn-secondary"
          disabled={perf.isRunning}
          onClick={perf.reset}
        >
          🔄 Reset
        </button>
      </div>

      <DeviceLimits
        settings={perf.settings}
        settingsError={perf.settingsError}
      />

      <div className="graph-section">
        <h3>Latency over time (last 60s)</h3>
        <LatencyGraph
          history={perf.latencyHistory}
          avgLatencyMs={perf.stats.avgLatencyMs}
          medianLatencyMs={perf.stats.medianLatencyMs}
        />
      </div>

      <StatsGrid stats={perf.stats} />
    </section>
  );
}

export default App;
