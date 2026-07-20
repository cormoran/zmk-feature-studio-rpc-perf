# Renode transport benchmark for the `zmk__perf` custom Studio RPC

A headless, hardware-free benchmark that characterises the ZMK Studio **custom
RPC** round trip across transport paths under [Renode](https://renode.io), using
this module's `zmk__perf` subsystem (`src/studio/perf_handler.c`). For each path
it sweeps the perf echo **size** upward and records, per size, the round-trip
**latency** (min/mean/median/p95/max) and **stability** (success rate over N
repeats + the dominant failure reason).

This is **Phase 1**: the direct host-link paths only (`split=false`). It is a
manual analysis tool — **not** wired into CI.

## What it measures

| path | build (snippets) | Studio transport | driven by |
|------|------------------|------------------|-----------|
| `uart` | `renode-studio-uart` | Studio RPC over an emulated UART | `boot_single` |
| `usb-single` | `studio-rpc-usb-uart` | one USB CDC (Studio only) | `boot_single_real` + `attach_dual_cdc_bridge` |
| `usb-dual` | `studio-rpc-usb-uart` + `zmk-usb-logging` | two USB CDC (console + Studio) | same, Studio = 2nd CDC |

Two sweeps per path:
- **response_size (TX / device→host):** grow the echoed response, tiny request.
- **request data (RX / host→device):** grow the request `data` padding, tiny
  response — isolates the RX path from the TX path.

`SettingsRequest` is queried once per build and recorded (RX/TX ring-buffer
sizes, the custom-subsystem request-payload cap, and the perf data caps).

## Files

- `perf_framing.py` — wraps a `zmk.perf.Request` inside the Studio custom-call
  envelope (`Request.custom.call{subsystem_index=0, payload}`) and decodes the
  `Response.request_response.custom.call.payload`. Mirrors the proven pmw3610
  module Renode pattern.
- `perf_sweep.py` — the sweep driver (boot per path, sweep, emit CSV + JSON).
- `build-renode.yaml` — the three Phase-1 build targets.
- `results/` — committed CSV + JSON outputs.
- [`../../docs/renode-perf-sweep.md`](../../docs/renode-perf-sweep.md) — the
  analysis writeup (breakpoints, latency, verdicts).

## Reproduce

```bash
# 1. Self-contained west workspace inside this repo (own .west; see below).
export ZEPHYR_SDK_INSTALL_DIR=/path/to/zephyr-sdk-0.16.8
west update            # fetches cormoran/zmk (main+custom-studio-protocol) + zmk-west-commands

# 2. Build the three Phase-1 images (module root auto-added as an extra module).
west zmk-build tests/zmk-config --build-yaml tests/renode/build-renode.yaml

# 3. Run one path at a time (serialize — only ONE Renode instance at a time).
python3 tests/renode/perf_sweep.py --path uart \
    --elf build/perf_uart/zephyr/zmk.elf --out-dir tests/renode/results
python3 tests/renode/perf_sweep.py --path usb-single \
    --elf build/perf_usb_single/zephyr/zmk.elf --out-dir tests/renode/results
python3 tests/renode/perf_sweep.py --path usb-dual \
    --elf build/perf_usb_dual/zephyr/zmk.elf --out-dir tests/renode/results
```

The workspace is initialised standalone (its own `.west/config` with
`path = west`, `file = west-test-standalone.yml`, `base = dependencies/zephyr`)
so a parent `/home/…/.west` cannot shadow it.

### USB paths require the #30 emulator-model fix

The USB sweeps need cormoran/zmk-west-commands **PR #30**
(`claude/usb-out-endpoint-rearm`), which fixes a `DualCdcAcmBridge` bug where the
device→host read one-shot was re-armed synchronously inside the callback and then
clobbered by `HandlePacket`'s trailing `dataCallback = null`, so only the FIRST
device→host chunk per session was ever delivered (it *looked* like "USB responses
past ~30 B get truncated"). `west-test-dependency.yml` therefore pins
`zmk-west-commands` to that branch; revert to `main` once #30 merges. Without the
fix, the USB numbers are a model artifact, not a firmware limit.

## Renode boot gotcha (handled by the driver)

`xiao_ble//zmk` links the image at the Adafruit-UF2 bootloader offset
(`CONFIG_FLASH_LOAD_OFFSET = 0x27000`), so the Cortex-M reset vector is there,
not at `0x0`. Renode's `sysbus LoadELF` sets the entry PC but the CPU still
resets via `VTOR=0` (empty flash → PC=0, silent dead boot). The driver, before
`start`: waits for the flash vector word to populate (LoadELF, run as the
`.resc`'s last line, is not done when `connect_uart` returns), sets
`sysbus.cpu VectorTableOffset 0x27000`, then verifies the CPU actually executes.
It also kills the whole Renode process tree on teardown (the launcher orphans its
`renode`/mono child otherwise) — only ever its own instance.
