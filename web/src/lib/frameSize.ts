/**
 * Studio custom RPC frame-size math.
 *
 * Estimates how large an encoded PerfRequest ends up once wrapped in the
 * Studio custom-subsystem call envelope and transport framing, so the UI can
 * clamp request sizes to what the firmware's RX buffer can actually decode.
 */
import { Request } from "../proto/zmk/perf/perf";
import type { SettingsResponse } from "../proto/zmk/perf/perf";

export const DEFAULT_DATA_SIZE_MAX = 2048;

export function encodedPerfRequestLength(
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

export function varintLength(value: number): number {
  let length = 1;
  while (value >= 0x80) {
    value = Math.floor(value / 0x80);
    length += 1;
  }
  return length;
}

export function lengthDelimitedFieldLength(
  tagLength: number,
  payloadLength: number
): number {
  return tagLength + varintLength(payloadLength) + payloadLength;
}

export function framedStudioCustomCallRequestLength(
  customPayloadLength: number,
  subsystemIndex: number | undefined
): number {
  const subsystemIndexLength = subsystemIndex && subsystemIndex > 0 ? 2 : 0;
  const callRequestLength =
    subsystemIndexLength + lengthDelimitedFieldLength(1, customPayloadLength);
  const customRequestLength = lengthDelimitedFieldLength(1, callRequestLength);

  // Reserve a two-byte request_id varint because request IDs quickly pass 127.
  const requestIdLength = 3;
  const studioCustomTagLength = 2;
  const studioRequestLength =
    requestIdLength +
    lengthDelimitedFieldLength(studioCustomTagLength, customRequestLength);

  // Studio transport framing adds SOF and EOF. This does not include rare escape bytes.
  return studioRequestLength + 2;
}

export function requestSizeMax(
  settings: SettingsResponse | null,
  responseSize: number,
  split: boolean,
  subsystemIndex: number | undefined
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
    const customPayloadLength = encodedPerfRequestLength(
      mid,
      responseSize,
      split
    );
    const framedRequestLength = framedStudioCustomCallRequestLength(
      customPayloadLength,
      subsystemIndex
    );
    if (
      customPayloadLength <= payloadMax &&
      framedRequestLength <= settings.studioRpcRxBufSize
    ) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return lo;
}

export function responseSizeMax(
  settings: SettingsResponse | null,
  split: boolean
) {
  if (!settings) return DEFAULT_DATA_SIZE_MAX;

  let max = settings.perfResponseDataMaxBytes || DEFAULT_DATA_SIZE_MAX;
  if (split && settings.splitRelayResponseDataMaxBytes > 0) {
    max = Math.min(max, settings.splitRelayResponseDataMaxBytes);
  }
  return max;
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined || value === 0) return "—";
  if (value >= 1024) return `${value} B (${(value / 1024).toFixed(1)} KiB)`;
  return `${value} B`;
}
