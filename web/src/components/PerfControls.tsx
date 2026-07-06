import { StepInput } from "./StepInput";

export function PerfControls({
  useSplit,
  setUseSplit,
  isRunning,
  splitDisabled,
  requestSize,
  maxRequestSize,
  setRequestSize,
  responseSize,
  maxResponseSize,
  setResponseSize,
  intervalMs,
  setIntervalMs,
  effectiveWindowSize,
  setWindowSize,
}: {
  useSplit: boolean;
  setUseSplit: (v: boolean) => void;
  isRunning: boolean;
  splitDisabled: boolean;
  requestSize: number;
  maxRequestSize: number;
  setRequestSize: (v: number) => void;
  responseSize: number;
  maxResponseSize: number;
  setResponseSize: (v: number) => void;
  intervalMs: number;
  setIntervalMs: (v: number) => void;
  effectiveWindowSize: number;
  setWindowSize: (v: number) => void;
}) {
  return (
    <div className="perf-controls">
      <div className="input-group">
        <span className="input-group-label">Target:</span>
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
            disabled={isRunning || splitDisabled}
            title={
              splitDisabled
                ? "Firmware was not built with CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY"
                : undefined
            }
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
          value={requestSize}
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
          value={responseSize}
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

      <div className="input-group">
        <label htmlFor="window-size">Max in-flight requests:</label>
        <StepInput
          id="window-size"
          value={effectiveWindowSize}
          min={1}
          max={16}
          smallStep={1}
          largeStep={4}
          presets={[1, 2, 4, 8, 16]}
          disabled={isRunning || useSplit}
          onChange={setWindowSize}
        />
        {useSplit && (
          <p className="stat-sub">
            Forced to 1 for the Split target — the firmware only tracks one
            outstanding split request at a time.
          </p>
        )}
      </div>
    </div>
  );
}
