/**
 * ZMK Studio RPC Performance Measurement
 *
 * Measures round-trip latency, throughput (bits/s) and packet-loss rate
 * of the ZMK Studio custom RPC protocol over USB (serial) or BLE.
 */

import { useContext, useState } from "react";
import "./App.css";
import { connect as serial_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/serial";
import { connect as ble_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/gatt";
import { ZMKConnection, ZMKAppContext } from "@cormoran/zmk-studio-react-hook";
import { usePerfTest } from "./hooks/usePerfTest";
import { useBenchmarkSweep } from "./hooks/useBenchmarkSweep";
import { PerfControls } from "./components/PerfControls";
import { DeviceLimits } from "./components/DeviceLimits";
import { StatsGrid } from "./components/StatsGrid";
import { LatencyGraph } from "./components/LatencyGraph";
import { SweepPanel } from "./components/SweepPanel";

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
  const sweep = useBenchmarkSweep({
    serviceRef: perf.serviceRef,
    settings: perf.settings,
    subsystemIndex,
  });
  const [mode, setMode] = useState<"manual" | "sweep">("manual");

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

      <div className="input-group">
        <span className="input-group-label">Mode:</span>
        <div className="target-toggle">
          <button
            id="mode-manual"
            type="button"
            className={`target-option${mode === "manual" ? " target-active" : ""}`}
            onClick={() => setMode("manual")}
          >
            Manual
          </button>
          <button
            id="mode-sweep"
            type="button"
            className={`target-option${mode === "sweep" ? " target-active" : ""}`}
            onClick={() => setMode("sweep")}
          >
            Sweep
          </button>
        </div>
      </div>

      {mode === "manual" ? (
        <>
          <PerfControls
            useSplit={perf.useSplit}
            setUseSplit={perf.setUseSplit}
            isRunning={perf.isRunning}
            splitDisabled={perf.settings?.splitRelayEnabled === false}
            requestSize={perf.effectiveRequestSize}
            maxRequestSize={perf.maxRequestSize}
            setRequestSize={perf.setRequestSize}
            responseSize={perf.effectiveResponseSize}
            maxResponseSize={perf.maxResponseSize}
            setResponseSize={perf.setResponseSize}
            intervalMs={perf.intervalMs}
            setIntervalMs={perf.setIntervalMs}
            effectiveWindowSize={perf.effectiveWindowSize}
            setWindowSize={perf.setWindowSize}
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

          {perf.stats.lastErrorMessage && (
            <div className="warning-message">
              <p>⚠ {perf.stats.lastErrorMessage}</p>
            </div>
          )}

          <div className="graph-section">
            <h3>Latency over time (last 60s)</h3>
            <LatencyGraph
              history={perf.latencyHistory}
              avgLatencyMs={perf.stats.avgLatencyMs}
              medianLatencyMs={perf.stats.medianLatencyMs}
            />
          </div>

          <StatsGrid stats={perf.stats} />
        </>
      ) : (
        <SweepPanel
          deviceName={zmkApp.state.deviceInfo?.name ?? "unknown"}
          settings={perf.settings}
          dimension={sweep.dimension}
          setDimension={sweep.setDimension}
          selectedSizes={sweep.selectedSizes}
          setSelectedSizes={sweep.setSelectedSizes}
          requestsPerStep={sweep.requestsPerStep}
          setRequestsPerStep={sweep.setRequestsPerStep}
          fixedRequestSize={sweep.fixedRequestSize}
          setFixedRequestSize={sweep.setFixedRequestSize}
          fixedResponseSize={sweep.fixedResponseSize}
          setFixedResponseSize={sweep.setFixedResponseSize}
          useSplit={sweep.useSplit}
          setUseSplit={sweep.setUseSplit}
          isSweeping={sweep.isSweeping}
          results={sweep.results}
          skippedCount={sweep.skippedCount}
          start={sweep.start}
          stop={sweep.stop}
        />
      )}

      <DeviceLimits
        settings={perf.settings}
        settingsError={perf.settingsError}
      />
    </section>
  );
}

export default App;
