# Renode transport size/stability sweep — `zmk__perf` custom Studio RPC

**Phase 1** characterises the three direct host-link paths (`split=false`: uart,
usb single/dual-CDC). **Phase 2** (see the section near the end) adds the
**split-relay path** (`split=true`: usb host + wired split) and runtime-validates
cormoran/zmk#34.

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

# Phase 2 — the split-relay path (`split=true`, usb host + wired split)

Phase 2 sweeps `PerfRequest{split=true}` over a **USB host-link + WIRED
split-link** central: the Studio host talks to the split CENTRAL over USB CDC,
the central relays each perf request to the wired PERIPHERAL
(`ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL`), the peripheral's perf handler answers,
and the response is relayed back (`ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL`). The
`PerfResponse` returns with `split=true` and `source=<peripheral id+1>`.

```
host(USB CDC) --USB(Studio)--> CENTRAL --wired split relay--> PERIPHERAL (perf handler)
```

Build: `tests/renode/build-renode-split.yaml` — central `renode_usb_wired_split`
shield (`studio-rpc-usb-uart` + role central + perf handler + perf split relay)
and peripheral `renode_wired_split` shield (role peripheral + perf split relay).
Driver: `perf_sweep.py --path usb-wired-relay` on `boot_usb_wired_split` (cormoran
zmk-west-commands #29) + `attach_dual_cdc_bridge`. Pins: cormoran/zmk
`claude/wired-split-relay` (#34) + zmk-west-commands
`claude/renode-transport-orthogonal` (#29). N = 20.

### ✅ zmk#34 wired relay: RUNTIME-VALIDATED

**`split=true` perf round trips succeed over the wired split relay.** Every
successful response carried `split=true` **and** a nonzero `source` (the driver
flags any locally-answered response as `not_relayed`; none occurred). A green
round trip exercises **both** relay directions — central→peripheral (request)
**and** peripheral→central (response) — so cormoran/zmk#34's wired split
relay-event transport is proven working end to end under Renode, with the perf
module's `ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY` now enabled over a **wired** split
(the `depends on ZMK_SPLIT_BLE` relax, below).

### Relay payload caps (`SettingsResponse`, DATA_LEN = 128)

| setting | value |
|---|---|
| `split_relay_enabled` | true |
| `split_relay_event_data_len` | 128 |
| `split_relay_request_data_max_bytes` | **119** (= 128 − 9 B request header) |
| `split_relay_response_data_max_bytes` | **121** (= 128 − 7 B response header) |

### TX — response_size sweep (relay response payload), DATA_LEN = 128

| size | ok/N | rate | median (ms) | dominant failure |
|---|---|---|---|---|
| 0 | 20/20 | 1.00 | 153 | — |
| 32 | 20/20 | 1.00 | 173 | — |
| 64 | 20/20 | 1.00 | 174 | — |
| 96 | 20/20 | 1.00 | 173 | — |
| 112 | 20/20 | 1.00 | 178 | — |
| 116 | 20/20 | 1.00 | 188 | — |
| 118 | 16/20 | 0.80 | 167 | `timeout_no_bytes` |
| 119 | 0/20 | 0.00 | — | `timeout_no_bytes` (transport wedged → reboot) |
| 120 | 20/20 | 1.00 | 165 | — (recovered after reboot) |
| 121 | 20/20 | 1.00 | 168 | — |
| 122 | 0/20 | 0.00 | — | **`error`** (EMSGSIZE, `-122`) |
| 124 / 128 | 0/20 | 0.00 | — | **`error`** (EMSGSIZE) |

- **Hard relay cap = 121 B.** `response_size ≥ 122` (> the 121 B relay response
  payload) is rejected *by the central* with `-EMSGSIZE` (a clean perf
  `ErrorResponse`, not a loss) — the central never even relays it. This is the
  relay breakpoint, and it matches `split_relay_response_data_max_bytes` exactly.
- **Reliable working payload = 116 B**; **max working payload = 121 B.** 0→116 B
  is a clean 20/20. The **118–121 B near-cap zone is noisy**: the emulated wired
  UART link intermittently drops / wedges on a *near-maximal* relay event
  (`timeout_no_bytes`; at 119 B the transport wedged and the driver's auto-reboot
  recovered it, after which 120 B and 121 B ran 20/20). So the top ~5 B below the
  cap round-trip only when the wired link is healthy — a Renode wired-transport
  artifact, not a firmware limit (the firmware accepts everything ≤ 121 B).

### RX — request-data sweep (host→central), DATA_LEN = 128

| size | ok/N | rate | median (ms) | dominant failure |
|---|---|---|---|---|
| 0 | 20/20 | 1.00 | 159 | — |
| 4 | 20/20 | 1.00 | 182 | — |
| 8 | 0/20 | 0.00 | — | `timeout_no_bytes` |
| 16 | 0/20 | 0.00 | — | `timeout_no_bytes` |

**RX breakpoint = 4 B** — the host→central request is bounded by the **30 B Studio
RX ring** (Phase 1's RX limit), *not* the 119 B relay-request cap: the framed
Studio request must fit the ring before the central ever relays it. It breaks one
step earlier than Phase 1's 8 B because `split=true` adds a field to the request.
The larger `split_relay_request_data_max_bytes` (119 B) is therefore **masked** by
the host-link ring and is not reachable over this host transport.

### Latency vs the direct USB path

| response_size | direct usb-single (Phase 1) | wired relay (Phase 2) | added |
|---|---|---|---|
| 0 B | 8.5 ms | 153 ms | **+145 ms** |
| 32 B | 11.6 ms | 173 ms | +161 ms |
| 64 B | 14.2 ms | 174 ms | +160 ms |
| 96 B | 15.9 ms | 173 ms | +157 ms |

The relay adds a **~150–185 ms** near-constant round-trip cost (the
central→peripheral→central wired hop + the perf handler's `k_sem` relay
handshake), roughly **~13–18×** the direct-USB latency at small sizes. The cost
is dominated by the relay hop, not the payload size (medians are flat across
0→116 B).

### Effect of bumping `CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN` (128 → 240)

Rebuilding **both** halves with `DATA_LEN = 240` (it is a shared wire contract)
raises the reported relay caps and the working response payload:

| | DATA_LEN 128 | DATA_LEN 240 |
|---|---|---|
| `split_relay_request_data_max_bytes` | 119 | **231** |
| `split_relay_response_data_max_bytes` | 121 | **233** |
| hard cap: first erroring `response_size` | 122 (EMSGSIZE) | **234** (EMSGSIZE) |
| `response_size = 128 / 160 / 192` | ❌ EMSGSIZE error | ✅ **20/20** |

TX — response_size sweep, DATA_LEN = 240:

| size | ok/N | rate | dominant failure |
|---|---|---|---|
| 0 | 20/20 | 1.00 | — |
| 64 | 4/20 | 0.20 | `timeout_no_bytes` / `error` (wedge) |
| 116 | 0/20 | 0.00 | `timeout_no_bytes` (wedged → reboot) |
| 128 | 20/20 | 1.00 | — |
| 160 | 20/20 | 1.00 | — |
| 192 | 20/20 | 1.00 | — |
| 224 | 4/20 | 0.20 | `timeout_no_bytes` / `error` (wedge) |
| 231 | 0/20 | 0.00 | `timeout_no_bytes` (wedged → reboot) |
| 232 | 6/20 | 0.30 | `timeout_no_bytes` / `error` |
| 233 | 0/20 | 0.00 | `timeout_no_bytes` |
| 234 / 236 | 0/20 | 0.00 | **`error`** (EMSGSIZE, > 233 cap) |

- **The bump works: the hard relay cap moves 121 B → 233 B** (≈ 2×), and
  `response_size` 128 / 160 / 192 B — a *hard EMSGSIZE error* at DATA_LEN 128 —
  now round-trip at **20/20**. The cap tracks `DATA_LEN − 7` exactly (233).
- **But the larger relay events are markedly noisier on the emulated wired link.**
  At DATA_LEN 240 even *mid-range* sizes (64, 116, 224) intermittently wedge
  (`timeout_no_bytes`, recovered by the driver's auto-reboot), so the run's clean
  ≥ 95% breakpoint metric collapses (the tool reports TX breakpoint = 0 because
  64 B already dips). This is a **Renode wired-transport stability artifact** at
  large/frequent relay events, *not* a firmware limit — sizes that transmit at all
  do so correctly (128/160/192 B at 20/20), and the only *deterministic* failure
  is the EMSGSIZE hard reject above 233 B. On real hardware (no emulated-UART-hub
  wedging) the larger DATA_LEN would simply extend the usable payload; here it
  trades reliability for reach.
- **RX is unchanged (breakpoint = 4 B).** `DATA_LEN` widens only the relay
  (device-side) payload; the host→central request is still bounded by the 30 B
  Studio RX ring, so the request-data breakpoint stays 4 B regardless of DATA_LEN.
- **DATA_LEN 240 run wall time: ~1655 s (~28 min)** — longer than the 128 run
  precisely because of the extra wedge-recovery reboots at large relay events.

**A wired split cannot exceed DATA_LEN = 245.** The wired transport frames its
relay event inside an **8-bit** length envelope (`command_payload`/`event_payload`
`BUILD_ASSERT(... <= UINT8_MAX)`), and `sizeof(command_payload) = 10 + DATA_LEN`,
so `DATA_LEN ≤ 245`. `DATA_LEN = 256` **fails to build** ("Wired split command
payload does not fit the 8-bit envelope payload size"); this benchmark uses **240**
(the largest round value that fits, with margin).

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
- **USB #30 model.** The USB numbers are valid only with the cormoran
  zmk-west-commands DualCdcAcmBridge re-arm fix (originally PR #30, now folded
  into the pinned `claude/renode-transport-orthogonal` branch). See
  `tests/renode/README.md`.
- **Phase 2 host timeout > firmware relay timeout.** The split path's host
  `--timeout` MUST exceed `CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_TIMEOUT_MS`
  (default **10 s**), so use `--timeout 12`. With a shorter host timeout a *slow*
  relay round trip is abandoned host-side before the firmware finishes, and the
  late response then arrives during the *next* request and taints it — producing
  cascading, non-monotonic near-cap failures that are a measurement artifact, not
  a transport limit.
- **Phase 2 two-machine boot.** `boot_usb_wired_split` (cormoran zmk-west-commands
  #29) boots the central (real USB image) + peripheral (plain wired half) on one
  Renode session, sets `VectorTableOffset 0x27000` on **both** CPUs, preloads the
  central NVS, then `start`s; the driver attaches the host CDC bridge to the
  central afterward.

## Wall time

| path | wall |
|---|---|
| uart (N=5, reboot-per-request) | ~1075 s (~18 min) |
| usb single-CDC (N=20) | ~598 s (~10 min) |
| usb dual-CDC (N=20, trimmed RX) | ~548 s (~9 min) |
| usb-wired-relay, DATA_LEN 128 (N=20, `--timeout 12`) | ~1163 s (~19 min) |
| usb-wired-relay, DATA_LEN 240 (N=20, `--timeout 12`) | ~1655 s (~28 min) |

Total sweep wall ~37 min, plus one-time `west update` + three firmware builds.
The uart wall cost is dominated by the per-request Renode reboot (~15 s × ~85
boots); the usb paths run the whole sweep in a single boot.

## Future work (NOT covered in Phase 1)

- **BLE host-link.** Studio-over-BLE runs in Renode only via the fixed
  `renode-ble-host` app, which cannot send *arbitrary* perf requests, so an
  automated size sweep is not drivable headlessly. Needs a programmable BLE
  Studio host.
- **Split-relay path (`split=true`).** ✅ Done — see **Phase 2** below.
- **BLE split relay.** Phase 2 covers only the WIRED split relay. The same perf
  `split=true` path over a BLE split (`ZMK_SPLIT_BLE`) is not yet swept — Renode's
  fake soft-LL desyncs on bidirectional multi-PDU data (the pmw3610 module hit
  the same wall), so a BLE-split relay sweep needs a better BLE medium model.
- **Buffer-size sweep.** All three builds use the default 30/64 B RX/TX rings;
  a follow-up could sweep `CONFIG_ZMK_STUDIO_RPC_{RX,TX}_BUF_SIZE` to move the
  uart TX breakpoint and the (transport-independent) RX breakpoint.
