/**
 * Human-readable descriptions for the perf RPC's structured ErrorCode enum.
 */
import { ErrorCode } from "../proto/zmk/perf/perf";

const NAMES: Partial<Record<ErrorCode, string>> = Object.fromEntries(
  Object.entries(ErrorCode).map(([name, value]) => [value, name])
);

const DESCRIPTIONS: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.ERROR_DECODE_FAILED]: "Firmware failed to decode the request",
  [ErrorCode.ERROR_UNSUPPORTED_REQUEST]: "Unsupported request type",
  [ErrorCode.ERROR_SPLIT_NOT_SUPPORTED]:
    "Split relay not supported by this firmware build",
  [ErrorCode.ERROR_SPLIT_BUSY]: "A split request is already in flight",
  [ErrorCode.ERROR_SPLIT_TIMEOUT]: "Split peripheral did not respond in time",
  [ErrorCode.ERROR_MSG_TOO_LARGE]: "Payload too large for the firmware limits",
};

export function describeErrorCode(code: ErrorCode, message: string): string {
  const description = DESCRIPTIONS[code];
  if (!description) return message || "Unknown error";
  return `${description} (${NAMES[code]})`;
}
