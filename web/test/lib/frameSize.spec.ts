/**
 * Tests for the pure Studio custom RPC frame-size math extracted from App.tsx.
 */
import {
  DEFAULT_DATA_SIZE_MAX,
  encodedPerfRequestLength,
  formatBytes,
  framedStudioCustomCallRequestLength,
  lengthDelimitedFieldLength,
  requestSizeMax,
  responseSizeMax,
  varintLength,
} from "../../src/lib/frameSize";
import type { SettingsResponse } from "../../src/proto/zmk/perf/perf";

function makeSettings(
  overrides: Partial<SettingsResponse> = {}
): SettingsResponse {
  return {
    studioRpcRxBufSize: 512,
    studioRpcTxBufSize: 1024,
    customSubsystemRequestPayloadMaxBytes: 512,
    splitRelayEnabled: true,
    splitRelayEventDataLen: 128,
    perfRequestDataMaxBytes: 2048,
    perfResponseDataMaxBytes: 2048,
    splitRelayRequestDataMaxBytes: 119,
    splitRelayResponseDataMaxBytes: 121,
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("renders a dash for undefined or zero", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("—");
  });

  it("renders plain bytes below 1 KiB", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("renders bytes with a KiB suffix at or above 1024", () => {
    expect(formatBytes(2048)).toBe("2048 B (2.0 KiB)");
  });
});

describe("varintLength", () => {
  it("is 1 byte for values below 128", () => {
    expect(varintLength(0)).toBe(1);
    expect(varintLength(127)).toBe(1);
  });

  it("is 2 bytes for values from 128 to 16383", () => {
    expect(varintLength(128)).toBe(2);
    expect(varintLength(16383)).toBe(2);
  });

  it("is 3 bytes starting at 16384", () => {
    expect(varintLength(16384)).toBe(3);
  });
});

describe("lengthDelimitedFieldLength", () => {
  it("sums tag, varint length prefix, and payload", () => {
    // tagLength=1, payload 10 bytes -> varint(10) is 1 byte
    expect(lengthDelimitedFieldLength(1, 10)).toBe(1 + 1 + 10);
    // payload 200 bytes -> varint(200) is 2 bytes
    expect(lengthDelimitedFieldLength(1, 200)).toBe(1 + 2 + 200);
  });
});

describe("responseSizeMax", () => {
  it("falls back to the default when settings are unavailable", () => {
    expect(responseSizeMax(null, false)).toBe(DEFAULT_DATA_SIZE_MAX);
  });

  it("uses perfResponseDataMaxBytes for local requests", () => {
    const settings = makeSettings({ perfResponseDataMaxBytes: 900 });
    expect(responseSizeMax(settings, false)).toBe(900);
  });

  it("clamps to the split relay response limit when targeting split", () => {
    const settings = makeSettings({
      perfResponseDataMaxBytes: 2048,
      splitRelayResponseDataMaxBytes: 121,
    });
    expect(responseSizeMax(settings, true)).toBe(121);
  });

  it("ignores a zero split relay limit (feature disabled)", () => {
    const settings = makeSettings({
      perfResponseDataMaxBytes: 2048,
      splitRelayResponseDataMaxBytes: 0,
    });
    expect(responseSizeMax(settings, true)).toBe(2048);
  });
});

describe("requestSizeMax", () => {
  it("falls back to the default when settings are unavailable", () => {
    expect(requestSizeMax(null, 0, false, undefined)).toBe(
      DEFAULT_DATA_SIZE_MAX
    );
  });

  it("returns perfRequestDataMaxBytes untouched when the custom payload limit is unset", () => {
    const settings = makeSettings({
      perfRequestDataMaxBytes: 1000,
      customSubsystemRequestPayloadMaxBytes: 0,
    });
    expect(requestSizeMax(settings, 0, false, 1)).toBe(1000);
  });

  it("binary-searches down to the largest size that fits both the custom payload and RX buffer limits", () => {
    const settings = makeSettings({
      perfRequestDataMaxBytes: 2048,
      customSubsystemRequestPayloadMaxBytes: 512,
      studioRpcRxBufSize: 512,
    });
    const responseSize = 0;
    const split = false;
    const subsystemIndex = 3;

    const max = requestSizeMax(settings, responseSize, split, subsystemIndex);

    // The chosen size must actually fit.
    const fitLength = encodedPerfRequestLength(max, responseSize, split);
    const fitFramed = framedStudioCustomCallRequestLength(
      fitLength,
      subsystemIndex
    );
    expect(fitLength).toBeLessThanOrEqual(
      settings.customSubsystemRequestPayloadMaxBytes
    );
    expect(fitFramed).toBeLessThanOrEqual(settings.studioRpcRxBufSize);

    // One byte more must violate at least one of the limits.
    const overLength = encodedPerfRequestLength(max + 1, responseSize, split);
    const overFramed = framedStudioCustomCallRequestLength(
      overLength,
      subsystemIndex
    );
    expect(
      overLength > settings.customSubsystemRequestPayloadMaxBytes ||
        overFramed > settings.studioRpcRxBufSize
    ).toBe(true);
  });

  it("clamps to the split relay request limit when targeting split", () => {
    const settings = makeSettings({
      perfRequestDataMaxBytes: 2048,
      customSubsystemRequestPayloadMaxBytes: 0,
      splitRelayRequestDataMaxBytes: 60,
    });
    expect(requestSizeMax(settings, 0, true, undefined)).toBe(60);
  });
});
