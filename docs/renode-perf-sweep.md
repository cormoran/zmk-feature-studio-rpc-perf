# Renode transport size/stability sweep — `zmk__perf` custom Studio RPC (Phase 1)

Headless [Renode](https://renode.io) 1.16.1 characterisation of the ZMK Studio
**custom RPC** round trip for this module's `zmk__perf` subsystem
(`src/studio/perf_handler.c`), across the three direct host-link transport paths.
Board `xiao_ble//zmk`, shield `my_awesome_keyboard`. No hardware; not run in CI.

Driver + raw data: [`tests/renode/perf_sweep.py`](../tests/renode/perf_sweep.py),
[`tests/renode/results/`](../tests/renode/results/) (CSV + JSON). Reproduction:
[`tests/renode/README.md`](../tests/renode/README.md).

Per path we send N repeats per size and record round-trip **latency**
(min/mean/median/p95/max) and **stability** (success rate + dominant failure
reason). Two sweeps per path: **response_size** (TX, device→host) and **request
data** padding (RX, host→device, tiny response). `SettingsRequest` is queried
once per build.

## Headline

| | uart | usb single-CDC | usb dual-CDC |
|---|---|---|---|
| **TX (response) breakpoint** | **8 B** (frame ~30 B) | **2048 B** (no stall to the nanopb cap) | **2048 B** (equivalent) |
| TX failure past breakpoint | `partial_frame_stall` | — | — |
| **RX (request) breakpoint** | **8 B** | **8 B** | **8 B** |
| RX failure past breakpoint | `timeout_no_bytes` (request rejected) | same | same |
| median latency @ small resp | ~30–40 ms | ~9–12 ms | ~9–12 ms |

Three findings:

1. **UART: the ~30 B custom-RPC TX stall is real and confirmed.** A perf response
   whose Studio-framed size exceeds ~30 B never finishes transmitting under
   Renode (`partial_frame_stall` — bytes start, the closing `0xAD` never comes).
   Additionally the UART TX ring **wedges permanently after ~2 responses** per
   boot, so only the *first response after a fresh boot* is a meaningful data
   point (the driver reboots per request on this path).
2. **USB: there is NO ~30 B stall.** On the emulator model with cormoran
   zmk-west-commands **PR #30** applied, USB single-CDC delivers *every* response
   size 0→2048 at 20/20, latency scaling smoothly 8 ms→154 ms. The pre-#30
   "USB truncates past ~30 B" symptom was a `DualCdcAcmBridge` model bug (the
   device→host read one-shot was re-armed synchronously and clobbered, so only
   the first chunk per session was delivered) — **not** a firmware/transport
   limit.
3. **USB single-CDC and dual-CDC are equivalent.** Dual-CDC does **not** extend
   the usable size — on the fixed model single-CDC already has no TX limit.
   The earlier "dual-CDC keeps the pump cycling" hypothesis was dual-CDC merely
   masking the re-arm bug; it is moot on the #30 model.
4. **The RX limit is transport-independent** (breakpoint 8 B on all three): a
   Studio request must fit the 30-byte RX ring, so once the framed request
   exceeds it the central drops it before the perf handler runs. This is a
   firmware/protocol buffer limit, identical over uart and usb.

## Build limits (`SettingsRequest`, once per build) — identical across all three

| setting | value |
|---|---|
| `studio_rpc_rx_buf_size` | 30 |
| `studio_rpc_tx_buf_size` | 64 |
| `custom_subsystem_request_payload_max_bytes` | 30 |
| `perf_request_data_max_bytes` | 2048 |
| `perf_response_data_max_bytes` | 2048 |
| `split_relay_enabled` | false |

`studio_rpc_rx_buf_size = 30` is the operative RX ceiling (the whole framed
Studio request must fit it); `perf_*_data_max_bytes = 2048` is the nanopb `data`
cap.

## uart (`renode-studio-uart` snippet, driven by `boot_single`)

N = 5, **reboot-per-request** (see Methodology). Latencies in ms.

**TX — response_size sweep**

| size | ok/N | rate | median | p95 | dominant failure |
|---|---|---|---|---|---|
| 0 | 5/5 | 1.00 | 29.6 | 40.6 | — |
| 8 | 5/5 | 1.00 | 40.7 | 76.0 | — |
| 16 | 0/5 | 0.00 | — | — | `partial_frame_stall` |
| 20 | 0/5 | 0.00 | — | — | `partial_frame_stall` |
| 24 | 0/5 | 0.00 | — | — | `partial_frame_stall` |
| 32–64 | — | — | — | — | early-stop (skipped) |

**Breakpoint = 8 B.** A `response_size=8` echo is a ~28-byte Studio frame on the
wire (fits under the 30 B ring); `response_size=16` is ~36 B and stalls
mid-frame. This is exactly the "~30 B" boundary, and the failure signature is a
frame that begins transmitting but never closes.

**RX — request data sweep** (response fixed at 8 B)

| size | ok/N | rate | median | dominant failure |
|---|---|---|---|---|
| 0 | 5/5 | 1.00 | 30.1 | — |
| 8 | 5/5 | 1.00 | 31.9 | — |
| 16 | 3/5 | 0.60 | 33.1 | `timeout_no_bytes` |
| 24 | 0/5 | 0.00 | — | `timeout_no_bytes` |
| 28 | 0/5 | 0.00 | — | `timeout_no_bytes` |
| 30 | 0/5 | 0.00 | — | `timeout_no_bytes` |

**Breakpoint = 8 B** (16 B is borderline — the framed request is right at the
30 B ring). Past it the request is silently dropped (no response at all).

## usb single-CDC (`studio-rpc-usb-uart`, no `zmk-usb-logging`)

Built with only the Studio CDC; driven by `boot_single_real` (NRF_USBD_Full usb
platform) + `attach_dual_cdc_bridge`, **PR #30 model**. N = 20, single boot per
sweep (USB does not wedge). Latencies in ms.

**TX — response_size sweep: 20/20 at EVERY size 0→2048.** No stall, no loss.

| size | median | p95 | | size | median | p95 |
|---|---|---|---|---|---|---|
| 0 | 8.5 | 21.5 | | 128 | 21.2 | 34.2 |
| 8 | 11.6 | 22.5 | | 256 | 27.0 | 36.6 |
| 16 | 9.7 | 17.0 | | 512 | 45.0 | 59.4 |
| 24 | 11.3 | 27.9 | | 768 | 64.6 | 100.2 |
| 30 | 17.7 | 30.1 | | 1024 | 82.7 | 144.7 |
| 32 | 11.6 | 31.0 | | 1536 | 114.0 | 133.8 |
| 64 | 14.2 | 27.4 | | 2048 | 153.6 | 191.4 |

**TX breakpoint = 2048 B** (the nanopb cap — no transport limit below it).

**RX — request data sweep**

| size | ok/N | rate | median | dominant failure |
|---|---|---|---|---|
| 0 | 20/20 | 1.00 | 11.4 | — |
| 8 | 20/20 | 1.00 | 13.8 | — |
| 16 | 2/20 | 0.10 | 12.4 | `timeout_no_bytes` |
| 24 | 0/20 | 0.00 | — | `timeout_no_bytes` |
| 28 | 0/20 | 0.00 | — | `timeout_no_bytes` |
| 30 | 0/20 | 0.00 | — | `timeout_no_bytes` |

**RX breakpoint = 8 B** — identical to uart, confirming the RX limit is the
30-byte request ring, not the transport.

## usb dual-CDC (`studio-rpc-usb-uart` + `zmk-usb-logging`)

Two CDC-ACM functions (console + Studio). N = 20, single boot. **Equivalent to
single-CDC** — the second CDC neither extends nor limits anything.

> CDC-ordering note: for this module's dual build the **Studio** RPC channel
> enumerates as **cdc0** and the console as cdc1 — the *reverse* of the
> zmk-west-commands smoke's assumption (console-first). The driver therefore
> auto-detects the Studio channel by probing each CDC with a perf request rather
> than assuming an index.

**TX — response_size sweep: 20/20 at EVERY size 0→2048**, same as single-CDC.

| size | median (ms) | | size | median (ms) |
|---|---|---|---|---|
| 0 | 7.7 | | 256 | 29.0 |
| 8 | 8.3 | | 512 | 42.6 |
| 64 | 10.7 | | 1024 | 75.2 |
| 128 | 17.4 | | 2048 | 135.8 |

**TX breakpoint = 2048 B** (identical to single-CDC; medians within noise —
dual-CDC is if anything marginally faster, so the log-CDC traffic does not slow
the Studio channel).

**RX — request data sweep**: same as single-CDC — 0 B and 8 B at 20/20 (~7–8 ms),
`request_data ≥ 16 B` fails (`timeout_no_bytes`), **RX breakpoint = 8 B**.

## Methodology notes

- **uart reboot-per-request.** The custom-RPC TX ring wedges after ~2 responses
  under Renode (a `partial_frame_stall` then `timeout_no_bytes` forever), and
  neither a `cpu Reset` nor a `machine Reset` un-wedges it cheaply. So on uart
  each measured request is issued as the *first* RPC after a fresh Renode boot
  (~15 s each), which is why uart uses N = 5 rather than the N = 20 used on usb
  (where a single boot serves the whole sweep, no wedge).
- **Boot gotcha (all paths).** `xiao_ble//zmk` links at the Adafruit-UF2
  bootloader offset `0x27000`, so the reset vector is there; Renode's `LoadELF`
  sets the entry PC but the CPU still resets via `VTOR=0` → PC 0 → silent dead
  boot. The driver waits for the flash vector word to populate (LoadELF runs
  last in the `.resc`, after `connect_uart` returns), sets
  `sysbus.cpu VectorTableOffset 0x27000`, then verifies the CPU executes, and
  kills the whole Renode process tree on teardown (only its own instance).
- **USB #30 model.** The USB numbers are valid only with cormoran
  zmk-west-commands PR #30 (`claude/usb-out-endpoint-rearm`); the workspace
  manifest pins it. See `tests/renode/README.md`.

## Wall time

| path | wall |
|---|---|
| uart (N=5, reboot-per-request) | ~1075 s (~18 min) |
| usb single-CDC (N=20) | ~598 s (~10 min) |
| usb dual-CDC (N=20, trimmed RX) | ~548 s (~9 min) |

Total sweep wall ~37 min, plus one-time `west update` + three firmware builds.
The uart wall cost is dominated by the per-request Renode reboot (~15 s × ~85
boots); the usb paths run the whole sweep in a single boot.

## Future work (NOT covered in Phase 1)

- **BLE host-link.** Studio-over-BLE runs in Renode only via the fixed
  `renode-ble-host` app, which cannot send *arbitrary* perf requests, so an
  automated size sweep is not drivable headlessly. Needs a programmable BLE
  Studio host.
- **Split-relay path (`split=true`).** Requires cormoran/zmk#34's wired split
  relay and relaxing the perf module's `ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY`
  `depends on ZMK_SPLIT_BLE`. Separate phase.
- **Buffer-size sweep.** All three builds use the default 30/64 B RX/TX rings;
  a follow-up could sweep `CONFIG_ZMK_STUDIO_RPC_{RX,TX}_BUF_SIZE` to move the
  uart TX breakpoint and the (transport-independent) RX breakpoint.
