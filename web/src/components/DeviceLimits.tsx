import type { SettingsResponse } from "../proto/zmk/perf/perf";
import { formatBytes } from "../lib/frameSize";

export function DeviceLimits({
  settings,
  settingsError,
}: {
  settings: SettingsResponse | null;
  settingsError: string | null;
}) {
  return (
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
  );
}
