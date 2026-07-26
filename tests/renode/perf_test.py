#!/usr/bin/env python3
"""Renode perf-RPC round-trip test for zmk-feature-studio-rpc-perf.

Run by `west zmk-renode-test tests/renode --mode <mode> ...` after the generic
boot+Studio smoke. This drives the module's own custom `zmk__perf` Studio
subsystem over the emulated transport and asserts a *stable stream* of correct
perf responses (the "responds reliably over a period" check): across many
iterations every request's sequence number is echoed back, the response carries
exactly `response_size` payload bytes, and -- in split modes -- the response
comes back through the split relay (split=true, with the peripheral `source`).

Mode support (see the README "Renode testing" section for the full table):

  * usb         -- non-split perf over the DUT's USB CDC (split=false).
  * wired-split -- perf RELAYED to the split peripheral over the wired link
                   (split=true), plus a non-split sanity pass on the central.
  * ble         -- non-split perf over the emulated BLE Studio GATT transport,
                   driven through the renode-ble-host RPC bridge. Needs
                   --host-elf (the host app).
  * usb x ble   -- perf RELAYED to the split peripheral over the BLE split link,
                   driven over the central's USB CDC (--host-link usb
                   --split-link ble). No preset name, no host app.
  * ble-split   -- the same relay, but the request also arrives over BLE
                   (peripheral <-BLE-> central <-BLE-> host). Needs --host-elf.

Both BLE split modes assert the same thing about the relay; they differ only in
how the request reaches the central. Prefer `usb x ble` -- it puts ONLY the split
link on the emulated radio (two machines, one pairing), where ble-split adds a
second encrypted link and a third machine and usually dies of an emulated
soft-link-layer assert before finishing. See the README's mode table.

Anything Studio-over-BLE goes through `renode_harness.BleRpcBridge` (the host
app's uart1), so one PerfRpcDriver drives every transport. Those modes are FAR
slower than usb/wired -- the emulated radio needs a 10us global quantum for the
whole exchange, not just for pairing (see the note by BLE_READY_TIMEOUT) -- so
they run a short stream rather than a long one.

The env contract (ZMK_RENODE_MODE / _HOST_LINK / _SPLIT_LINK / _ELF /
_PERIPHERAL_ELF / _HOST_ELF / _STORAGE_*) is set by `west zmk-renode-test`; see
docs/renode-testing.md in zmk-west-commands.
"""

from __future__ import annotations

import os
import re
import sys
import time
import unittest
from pathlib import Path

# `west zmk-renode-test` puts scripts/lib/renode on PYTHONPATH, so the harness
# and its RPC socket helper import directly.
import renode_harness  # noqa: E402

MODE = os.environ.get("ZMK_RENODE_MODE", "")
# The orthogonal axes behind MODE. usb+ble-split has no preset name, so it is
# selected by these rather than by MODE.
HOST_LINK = os.environ.get("ZMK_RENODE_HOST_LINK", "")
SPLIT_LINK = os.environ.get("ZMK_RENODE_SPLIT_LINK", "")
ELF = os.environ.get("ZMK_RENODE_ELF", "")
PERIPHERAL_ELF = os.environ.get("ZMK_RENODE_PERIPHERAL_ELF", "")
HOST_ELF = os.environ.get("ZMK_RENODE_HOST_ELF", "")

# Raised by the BLE RPC bridge; only present on a zmk-west-commands new enough to
# have it. Fall back so the usb / wired-split tests still run against an older
# pinned harness (the BLE tests skip themselves there -- see _ble_driver).
BridgeError = getattr(renode_harness, "BridgeError", RuntimeError)
STORAGE_ADDR = int(os.environ.get("ZMK_RENODE_STORAGE_ADDR", "0"), 0) or None
STORAGE_SIZE = int(os.environ.get("ZMK_RENODE_STORAGE_SIZE", "0"), 0) or None

# The USB platform + bridge, same names the harness/smoke use.
USB_REPL_TEMPLATE = "xiao_nrf52840_usb.repl"
USB_BRIDGE_NAME = "bridge"

PERF_SUBSYSTEM_IDENTIFIER = "zmk__perf"

# "Stable over a period" iteration counts. usb is a single machine and fast;
# wired-split adds the relay round trip (peripheral hop) so it is a bit slower --
# keep its count lower to bound Renode wall time while still exercising a
# sustained stream.
USB_ITERATIONS = 50
WIRED_ITERATIONS = 30
# A rotation of response sizes exercised across the stream (bytes the device
# echoes back). Kept modest so a wired relay response fits one relay event
# (CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN default 128 -> ~124 usable bytes).
RESPONSE_SIZES = [0, 1, 8, 32, 64, 100]

# The BLE modes are much slower than usb (the emulated radio needs a 10us global
# quantum for the whole exchange, and every response is chunked into 27-byte
# indications), so they assert a shorter stream over smaller payloads -- ~2s per
# round trip measured. ble-split pays for a second encrypted link plus the relay
# hop, so it does fewer still.
BLE_ITERATIONS = 12
BLE_SPLIT_ITERATIONS = 6
BLE_RESPONSE_SIZES = [0, 1, 8, 32]

RPC_TIMEOUT = 15.0
# Per-request budget over the emulated radio -- a BLE round trip is seconds of
# wall time, not milliseconds.
BLE_RPC_TIMEOUT = 240.0
# Wall budget for the BLE pairing phase (scan -> connect -> LE SC -> MTU ->
# subscribe). Deliberately not generous: pairing either completes in a couple of
# hundred seconds or the roll was bad and the host never even sees the DUT's
# advertisement (measured -- 18-33s for the two-machine case, 177s for a winning
# three-machine one, versus attempts that scan fruitlessly forever). Waiting
# longer buys nothing; a fresh emulation re-rolls the dice, which is what
# BLE_SPLIT_MAX_ATTEMPTS is for.
BLE_READY_TIMEOUT = 300.0
BLE_SPLIT_READY_TIMEOUT = 480.0
# The peripheral half logs this over RTT once the encrypted split link is up
# (renode_split_right.conf routes ZMK's logs there). Same markers the upstream
# ble-split smoke asserts on.
SPLIT_L2_NEEDLES = ["Security changed", "level 2"]
SPLIT_LINK_TIMEOUT = 300.0
# Zephyr's last words. The emulated soft link layer takes machines down with an
# LL assert; spotting it turns a full-budget wait into an immediate re-roll.
CRASH_MARKERS = (
    "ZEPHYR FATAL ERROR",
    "Kernel oops",
    "ASSERTION FAIL",
    "Halting system",
)

# NOTE: do NOT call renode_harness.raise_global_quantum() here. Coarsening the
# quantum after pairing is documented as safe, but that was measured against an
# encrypted GATT *read*; the RPC path (ATT write + response indications) breaks
# on the very next request -- measured on this DUT, at 0.001 the response never
# arrives and at 0.0001 the DUT rejects the write outright ("BRIDGE:WRITE-ERR
# att"). The 10us boot quantum is load-bearing for the whole BLE RPC exchange,
# which is why these tests do a handful of round trips rather than a stream.
BOOT_SETTLE = 8.0
WIRING_TIMEOUT = 30.0
BOOT_TIMEOUT = 20.0
# One whole-emulation retry (the run_usb_smoke pattern): a fresh boot re-rolls
# the wall-clock-paced USB attach, which can lose a race under heavy CI host
# contention. A genuine break fails BOTH attempts.
MAX_ATTEMPTS = 2
# ble-split gets more rolls: three machines and two LE-SC pairings share one
# emulated radio, and a bad roll costs the whole attempt (the host never sees the
# central's advertisement, or a chunked response indication is lost). Upstream's
# own ble-split job concluded the same -- retry the WHOLE emulation rather than
# hammering inside an attempt, which destabilises the soft link layer further.
# Three rolls at the (tight) budgets above keeps the job inside its 45min cap
# with room for the three firmware builds.
BLE_SPLIT_MAX_ATTEMPTS = 3


def _storage_kwargs() -> dict:
    kw = {}
    if STORAGE_ADDR is not None:
        kw["storage_addr"] = STORAGE_ADDR
    if STORAGE_SIZE is not None:
        kw["storage_size"] = STORAGE_SIZE
    return kw


def _console_tail(text: str, lines: int = 25) -> str:
    """Last `lines` of a captured console, with the log backend's colour codes
    stripped. The raw buffer is mostly ANSI escapes and \\r, which makes a
    failure message unreadable in CI output."""
    clean = re.sub(r"\x1b\[[0-9;]*m", "", text).replace("\r", "")
    return "\n".join(clean.splitlines()[-lines:])


def _mon_flag(mon, command: str) -> bool | None:
    """Run a monitor command whose reply is a bare boolean and return it (or
    None if no True/False line could be parsed from the colored/echoed reply)."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", mon.execute(command, settle=0.3))
    for line in text.splitlines():
        line = line.strip()
        if line in ("True", "False"):
            return line == "True"
    return None


def _compile_perf_pb2():
    """Compile this module's own perf.proto (package zmk.perf) alongside the
    studio protos and return the perf_pb2 module."""
    here = Path(__file__).resolve()
    # tests/renode/perf_test.py -> repo root is two levels up.
    repo_root = here.parent.parent.parent
    perf_proto_dir = repo_root / "proto" / "zmk" / "perf"
    perf_proto = perf_proto_dir / "perf.proto"
    if not perf_proto.is_file():
        raise unittest.SkipTest(f"perf.proto not found at {perf_proto}")
    try:
        renode_harness.compile_protos([perf_proto], include_dirs=[perf_proto_dir])
        import perf_pb2  # type: ignore

        return perf_pb2
    except RuntimeError as err:  # protoc missing / bad proto
        raise unittest.SkipTest(f"could not compile perf.proto: {err}")


def _load_studio_pb2():
    # find_studio_proto_dir wants the west topdir; `west zmk-renode-test` runs
    # from it, so cwd is the topdir.
    proto_dir = renode_harness.find_studio_proto_dir(Path.cwd())
    try:
        return renode_harness.load_studio_pb2(proto_dir)
    except RuntimeError as err:
        raise unittest.SkipTest(f"could not compile studio protos: {err}")


def _read_response(studio, studio_pb2, request_id: int, timeout: float):
    """Read frames until the RequestResponse for `request_id` arrives, skipping
    unsolicited notifications (perf never emits any, but be robust). Returns the
    parsed studio_pb2.Response, or None on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frame = studio.read_frame(timeout=deadline - time.monotonic())
        if frame is None:
            return None
        resp = studio_pb2.Response()
        try:
            resp.ParseFromString(frame)
        except Exception:
            continue
        if resp.WhichOneof("type") != "request_response":
            continue  # a notification; keep reading
        if resp.request_response.request_id == request_id:
            return resp
    return None


class PerfRpcDriver:
    """Sends `zmk__perf` custom-subsystem calls over a framed Studio socket and
    decodes the perf responses. `studio` is the RpcSocket the harness returns for
    the Studio CDC (has .send()/.read_frame())."""

    def __init__(self, studio, studio_pb2, perf_pb2):
        self.studio = studio
        self.studio_pb2 = studio_pb2
        self.perf_pb2 = perf_pb2
        self._request_id = 0
        self.subsystem_index = None

    def _next_request_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def discover_subsystem(self, timeout: float = RPC_TIMEOUT) -> int:
        """List the device's custom subsystems and record the perf index."""
        req = self.studio_pb2.Request()
        rid = self._next_request_id()
        req.request_id = rid
        req.custom.list_custom_subsystems.SetInParent()
        self.studio.send(req.SerializeToString())
        resp = _read_response(self.studio, self.studio_pb2, rid, timeout)
        if resp is None:
            raise AssertionError("no list_custom_subsystems response (timeout)")
        if resp.request_response.WhichOneof("subsystem") != "custom":
            raise AssertionError(
                "unexpected list_custom_subsystems response shape: "
                f"{resp.request_response.WhichOneof('subsystem')!r}"
            )
        subsystems = resp.request_response.custom.list_custom_subsystems.subsystems
        index = next(
            (s.index for s in subsystems if s.identifier == PERF_SUBSYSTEM_IDENTIFIER),
            None,
        )
        if index is None:
            found = ", ".join(s.identifier for s in subsystems) or "(none)"
            raise AssertionError(
                f"device does not expose the {PERF_SUBSYSTEM_IDENTIFIER!r} custom "
                f"subsystem (found: {found}) -- is CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER=y?"
            )
        self.subsystem_index = index
        return index

    def perf_roundtrip(
        self, seq: int, response_size: int, split: bool, timeout: float = RPC_TIMEOUT
    ):
        """Issue one PerfRequest and return the decoded PerfResponse. Raises
        AssertionError on any transport / decode / shape error."""
        assert self.subsystem_index is not None, "call discover_subsystem() first"

        perf_req = self.perf_pb2.Request()
        perf_req.perf.sequence_number = seq
        perf_req.perf.response_size = response_size
        perf_req.perf.split = split

        req = self.studio_pb2.Request()
        rid = self._next_request_id()
        req.request_id = rid
        req.custom.call.subsystem_index = self.subsystem_index
        req.custom.call.payload = perf_req.SerializeToString()
        self.studio.send(req.SerializeToString())

        resp = _read_response(self.studio, self.studio_pb2, rid, timeout)
        if resp is None:
            raise AssertionError(
                f"no perf response frame (timeout) for seq={seq} "
                f"response_size={response_size} split={split}"
            )
        if resp.request_response.WhichOneof("subsystem") != "custom":
            raise AssertionError(
                "perf response is not a custom-subsystem response: "
                f"{resp.request_response.WhichOneof('subsystem')!r}"
            )
        call = resp.request_response.custom.call
        perf_resp = self.perf_pb2.Response()
        perf_resp.ParseFromString(call.payload)
        kind = perf_resp.WhichOneof("response_type")
        if kind == "error":
            raise AssertionError(
                f"device returned a perf ErrorResponse for seq={seq} "
                f"split={split}: {perf_resp.error.message!r}"
            )
        if kind != "perf":
            raise AssertionError(f"expected a perf response, got {kind!r}")
        return perf_resp.perf


def _assert_stream(
    driver: PerfRpcDriver,
    iterations: int,
    split: bool,
    sizes: list[int] | None = None,
    timeout: float = RPC_TIMEOUT,
):
    """Drive `iterations` perf round trips (rotating response sizes) and assert
    every one echoes its sequence number, returns exactly response_size bytes,
    and matches the expected split flag. Returns the list of PerfResponses."""
    sizes = sizes if sizes is not None else RESPONSE_SIZES
    responses = []
    for i in range(iterations):
        seq = 0x1000 + i
        response_size = sizes[i % len(sizes)]
        perf = driver.perf_roundtrip(seq, response_size, split, timeout=timeout)

        if perf.sequence_number != seq:
            raise AssertionError(
                f"iter {i}: sequence mismatch: sent {seq}, got {perf.sequence_number} "
                "(response lost / reordered)"
            )
        if len(perf.data) != response_size:
            raise AssertionError(
                f"iter {i} (seq={seq}): expected {response_size} response bytes, "
                f"got {len(perf.data)}"
            )
        if perf.split != split:
            raise AssertionError(
                f"iter {i} (seq={seq}): expected split={split}, got split={perf.split}"
            )
        if split and perf.source == 0:
            # A relayed response carries the originating peripheral's source id
            # (framework-assigned, non-zero for a real peripheral hop).
            raise AssertionError(
                f"iter {i} (seq={seq}): split response has source=0 -- it did not "
                "come from a split peripheral relay"
            )
        responses.append(perf)
    return responses


class PerfRenodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ELF:
            raise unittest.SkipTest(
                "ZMK_RENODE_ELF not set (run via `west zmk-renode-test`)"
            )
        cls.renode_path = renode_harness.find_or_install_renode()
        if cls.renode_path is None:
            raise unittest.SkipTest(
                "Renode is not installed and could not be auto-installed"
            )
        cls.studio_pb2 = _load_studio_pb2()
        cls.perf_pb2 = _compile_perf_pb2()

    def _run_with_retry(self, attempt, max_attempts: int = MAX_ATTEMPTS):
        """Run `attempt` (a fresh-boot callable) with whole-emulation retries on
        a transport/boot flake; re-raise the last error if all of them fail."""
        last_err: Exception | None = None
        for n in range(1, max_attempts + 1):
            if n > 1:
                print(
                    f"[perf] --- retry {n}/{max_attempts} (fresh emulation; "
                    "previous attempt flaked) ---",
                    file=sys.stderr,
                )
            try:
                attempt()
                return
            except (AssertionError, TimeoutError, OSError, BridgeError) as err:
                last_err = err
                print(
                    f"[perf] attempt {n}/{max_attempts} FAILED: {err!r}",
                    file=sys.stderr,
                )
        assert last_err is not None
        raise last_err

    # -- usb mode -----------------------------------------------------------

    @unittest.skipUnless(MODE == "usb", "usb-mode test")
    def test_usb_perf_stream(self):
        """Non-split perf over the DUT's USB CDC: a sustained stream of correct,
        in-order, exact-size responses (all split=false)."""
        self._run_with_retry(self._usb_attempt)

    def _usb_attempt(self):
        import random

        port_base = random.randint(26000, 40000)
        session, console, rpc = renode_harness.boot_single_real(
            self.renode_path,
            Path(ELF),
            port_base=port_base,
            repl_template=USB_REPL_TEMPLATE,
            **_storage_kwargs(),
        )
        try:
            studio = self._attach_usb_studio(session, console, port_base)
            driver = PerfRpcDriver(studio, self.studio_pb2, self.perf_pb2)
            driver.discover_subsystem()
            print(
                f"[perf] usb: streaming {USB_ITERATIONS} non-split perf requests...",
                file=sys.stderr,
            )
            _assert_stream(driver, USB_ITERATIONS, split=False)
            print(
                f"[perf] usb OK: {USB_ITERATIONS}/{USB_ITERATIONS} perf round trips",
                file=sys.stderr,
            )
        finally:
            for s in getattr(self, "_cdc_sockets", []):
                s.close()
            rpc.close()
            console.close()
            session.stop()

    # -- wired-split mode ---------------------------------------------------

    @unittest.skipUnless(MODE in ("split", "wired-split"), "wired-split-mode test")
    def test_wired_split_perf_relay_stream(self):
        """Perf relayed to the split PERIPHERAL over the wired link: a sustained
        stream of correct split responses (split=true, peripheral source), plus a
        short non-split sanity pass answered locally by the central."""
        if not PERIPHERAL_ELF:
            raise unittest.SkipTest("ZMK_RENODE_PERIPHERAL_ELF not set for split mode")
        self._run_with_retry(self._wired_attempt)

    def _wired_attempt(self):
        import random

        port_base = random.randint(26000, 40000)
        session, central_console, peripheral_console = (
            renode_harness.boot_usb_wired_split(
                self.renode_path,
                central_elf=Path(ELF),
                peripheral_elf=Path(PERIPHERAL_ELF),
                port_base=port_base,
                **_storage_kwargs(),
            )
        )
        try:
            # The central boots and prints its banner on uart0 before we attach USB.
            renode_harness.wait_for_text(
                central_console._sock, "Welcome to ZMK", timeout=BOOT_TIMEOUT
            )
            studio = self._attach_usb_studio(session, central_console, port_base)
            driver = PerfRpcDriver(studio, self.studio_pb2, self.perf_pb2)
            driver.discover_subsystem()

            # Let both halves settle so the wired split link is up before relaying.
            time.sleep(3.0)

            # Non-split sanity: the central answers locally (split=false).
            print(
                "[perf] wired-split: non-split sanity pass on the central...",
                file=sys.stderr,
            )
            _assert_stream(driver, len(RESPONSE_SIZES), split=False)

            # The real test: relay each request to the peripheral (split=true).
            print(
                f"[perf] wired-split: streaming {WIRED_ITERATIONS} RELAYED perf "
                "requests to the peripheral...",
                file=sys.stderr,
            )
            _assert_stream(driver, WIRED_ITERATIONS, split=True)
            print(
                f"[perf] wired-split OK: {WIRED_ITERATIONS}/{WIRED_ITERATIONS} relayed "
                "perf round trips (peripheral)",
                file=sys.stderr,
            )
        finally:
            for s in getattr(self, "_cdc_sockets", []):
                s.close()
            peripheral_console.close()
            central_console.close()
            session.stop()

    # -- ble mode -----------------------------------------------------------

    @unittest.skipUnless(MODE == "ble", "ble-mode test")
    def test_ble_perf_stream(self):
        """Non-split perf over the emulated BLE Studio transport: the request is
        written to the DUT's Studio RPC GATT characteristic by the renode-ble-host
        app on the harness's behalf, and the chunked response indications are
        reassembled back into a PerfResponse."""
        if not HOST_ELF:
            raise unittest.SkipTest(
                "ZMK_RENODE_HOST_ELF not set -- ble mode needs --host-elf "
                "(the renode-ble-host app; see build-renode.yaml's header)"
            )
        self._run_with_retry(self._ble_attempt)

    def _ble_attempt(self):
        import random

        port_base = random.randint(26000, 40000)
        session, dut_console, dut_rpc, host_console = renode_harness.boot_ble_pair(
            self.renode_path,
            dut_elf=Path(ELF),
            host_elf=Path(HOST_ELF),
            port_base=port_base,
            **_storage_kwargs(),
        )
        try:
            drains = [("host_console", host_console._sock)]
            if session.dut_rtt is not None:
                drains.append(("dut_rtt", session.dut_rtt._sock))
            driver = self._ble_driver(session, drains, BLE_READY_TIMEOUT)
            print(
                f"[perf] ble: streaming {BLE_ITERATIONS} non-split perf requests "
                "over the encrypted BLE link...",
                file=sys.stderr,
            )
            _assert_stream(
                driver,
                BLE_ITERATIONS,
                split=False,
                sizes=BLE_RESPONSE_SIZES,
                timeout=BLE_RPC_TIMEOUT,
            )
            print(
                f"[perf] ble OK: {BLE_ITERATIONS}/{BLE_ITERATIONS} perf round trips over BLE",
                file=sys.stderr,
            )
        finally:
            self._close_bridge(session)
            for s in (dut_console, dut_rpc, host_console, session.dut_rtt):
                if s is not None:
                    s.close()
            session.stop()

    # -- usb x ble-split (usb host-link, ble split-link) ---------------------

    @unittest.skipUnless(
        (HOST_LINK, SPLIT_LINK) == ("usb", "ble"), "usb+ble-split-mode test"
    )
    def test_usb_ble_split_perf_relay_stream(self):
        """Perf relayed to the split PERIPHERAL over the BLE split link, driven
        over the central's USB CDC:

            peripheral <--BLE(split)--> central <--USB CDC--> test

        Same relay assertions as wired-split (split=true, non-zero peripheral
        source), so a relay regression shows up on either split transport -- but
        without ble-split's second radio link. That matters: with only the split
        link on the air this is two CPUs and one pairing instead of three CPUs and
        two racing pairings, so it is the configuration that actually completes.
        """
        if not PERIPHERAL_ELF:
            raise unittest.SkipTest(
                "ZMK_RENODE_PERIPHERAL_ELF not set for usb+ble-split"
            )
        self._run_with_retry(self._usb_ble_split_attempt, BLE_SPLIT_MAX_ATTEMPTS)

    def _usb_ble_split_attempt(self):
        import random

        port_base = random.randint(26000, 40000)
        session, central_console, peripheral_console = (
            renode_harness.boot_usb_ble_split(
                self.renode_path,
                central_elf=Path(ELF),
                peripheral_elf=Path(PERIPHERAL_ELF),
                port_base=port_base,
                **_storage_kwargs(),
            )
        )
        try:
            # Attach USB first: a real USB image busy-waits in USB init until the
            # host enumerates it, so nothing else the central should do -- pairing
            # included -- happens before this. `machines` covers BOTH halves, or
            # the machine-scoped pause freezes only the central and the split link
            # dies of supervision timeout (see attach_dual_cdc_bridge).
            time.sleep(BOOT_SETTLE)
            studio = self._attach_usb_studio(
                session, central_console, port_base, machines=("central", "peripheral")
            )

            # The encrypted split link is independent of USB; relaying before it
            # is up returns a perf ErrorResponse (-EAGAIN) that reads like a relay
            # bug. The peripheral's console is USB-CDC-silent, so watch its RTT.
            self._wait_for_split_l2(session)
            print("[perf] usb+ble-split: encrypted split link up", file=sys.stderr)

            driver = PerfRpcDriver(studio, self.studio_pb2, self.perf_pb2)
            driver.discover_subsystem()

            # Non-split sanity: the central answers locally (split=false).
            print(
                "[perf] usb+ble-split: non-split sanity pass on the central...",
                file=sys.stderr,
            )
            _assert_stream(driver, len(RESPONSE_SIZES), split=False)

            print(
                f"[perf] usb+ble-split: streaming {BLE_SPLIT_ITERATIONS} RELAYED perf "
                "requests to the peripheral over the BLE split link...",
                file=sys.stderr,
            )
            _assert_stream(
                driver,
                BLE_SPLIT_ITERATIONS,
                split=True,
                sizes=BLE_RESPONSE_SIZES,
                timeout=BLE_RPC_TIMEOUT,
            )
            print(
                f"[perf] usb+ble-split OK: {BLE_SPLIT_ITERATIONS}/{BLE_SPLIT_ITERATIONS} "
                "relayed perf round trips (peripheral, over the BLE split link)",
                file=sys.stderr,
            )
        finally:
            for s in getattr(self, "_cdc_sockets", []):
                s.close()
            for s in (
                central_console,
                peripheral_console,
                session.central_rtt,
                session.peripheral_rtt,
            ):
                if s is not None:
                    s.close()
            session.stop()

    def _wait_for_split_l2(self, session):
        """Block until the peripheral's RTT shows the encrypted split link, giving
        up early if either half halts (the emulated soft link layer takes machines
        down with an LL assert, and waiting out the budget on a corpse is waste)."""
        deadline = time.monotonic() + SPLIT_LINK_TIMEOUT
        buf = ""
        while time.monotonic() < deadline:
            buf += renode_harness.drain_text(session.peripheral_rtt._sock, timeout=0.5)
            if all(n in buf for n in SPLIT_L2_NEEDLES):
                return
            crash = next((m for m in CRASH_MARKERS if m in buf), None)
            if crash is not None:
                raise AssertionError(
                    f"the split peripheral halted ({crash!r}) while the split link was "
                    f"coming up. RTT tail:\n{_console_tail(buf)}"
                )
        raise AssertionError(
            f"the BLE split link never reached L2 within {SPLIT_LINK_TIMEOUT:.0f}s. "
            f"Peripheral RTT tail:\n{_console_tail(buf)}"
        )

    # -- ble-split mode -----------------------------------------------------

    @unittest.skipUnless(MODE == "ble-split", "ble-split-mode test")
    def test_ble_split_perf_relay_stream(self):
        """Perf relayed to the split PERIPHERAL over the BLE split link, with the
        request reaching the central over its own encrypted BLE link to the host:
        peripheral <--BLE(split)--> central <--BLE(Studio)--> host. Asserts the
        same split=true / non-zero peripheral source as wired-split, so a relay
        regression shows up on either split transport."""
        if not PERIPHERAL_ELF:
            raise unittest.SkipTest(
                "ZMK_RENODE_PERIPHERAL_ELF not set for ble-split mode"
            )
        if not HOST_ELF:
            raise unittest.SkipTest("ZMK_RENODE_HOST_ELF not set for ble-split mode")
        self._run_with_retry(self._ble_split_attempt, BLE_SPLIT_MAX_ATTEMPTS)

    def _ble_split_attempt(self):
        import random

        port_base = random.randint(26000, 40000)
        session, central_console, peripheral_rtt, host_console = (
            renode_harness.boot_ble_split(
                self.renode_path,
                central_elf=Path(ELF),
                peripheral_elf=Path(PERIPHERAL_ELF),
                host_elf=Path(HOST_ELF),
                port_base=port_base,
                **_storage_kwargs(),
            )
        )
        try:
            drains = [("host_console", host_console._sock)]
            if peripheral_rtt is not None:
                drains.append(("peripheral_rtt", peripheral_rtt._sock))
            if session.central_rtt is not None:
                drains.append(("central_rtt", session.central_rtt._sock))
            driver = self._ble_driver(session, drains, BLE_SPLIT_READY_TIMEOUT)

            # The host link coming up says nothing about the SPLIT link, and the
            # two pair independently on one emulated radio. Relaying before the
            # peripheral is connected just makes the central answer with a perf
            # ErrorResponse (-EAGAIN), which reads like a relay bug -- so wait
            # for the peripheral's own "Security changed ... level 2" first.
            bridge = session.host_bridge
            if not bridge.wait_for_drain(
                "peripheral_rtt", SPLIT_L2_NEEDLES, timeout=SPLIT_LINK_TIMEOUT
            ):
                raise AssertionError(
                    f"the BLE split link never reached L2 within {SPLIT_LINK_TIMEOUT:.0f}s "
                    "(emulated-radio pairing flake). Peripheral RTT tail:\n"
                    f"{_console_tail(bridge.drained.get('peripheral_rtt', ''))}"
                )
            print("[perf] ble-split: encrypted split link up", file=sys.stderr)

            # Non-split sanity first: the central answers locally, so a failure
            # here means the Studio path is broken, not the split relay.
            print(
                "[perf] ble-split: non-split sanity pass on the central...",
                file=sys.stderr,
            )
            _assert_stream(
                driver,
                1,
                split=False,
                sizes=BLE_RESPONSE_SIZES,
                timeout=BLE_RPC_TIMEOUT,
            )

            print(
                f"[perf] ble-split: streaming {BLE_SPLIT_ITERATIONS} RELAYED perf "
                "requests to the peripheral over the BLE split link...",
                file=sys.stderr,
            )
            _assert_stream(
                driver,
                BLE_SPLIT_ITERATIONS,
                split=True,
                sizes=BLE_RESPONSE_SIZES,
                timeout=BLE_RPC_TIMEOUT,
            )
            print(
                f"[perf] ble-split OK: {BLE_SPLIT_ITERATIONS}/{BLE_SPLIT_ITERATIONS} relayed "
                "perf round trips (peripheral, over BLE)",
                file=sys.stderr,
            )
        finally:
            self._close_bridge(session)
            for s in (
                central_console,
                peripheral_rtt,
                host_console,
                session.central_rtt,
            ):
                if s is not None:
                    s.close()
            session.stop()

    # -- shared BLE plumbing ------------------------------------------------

    def _ble_driver(self, session, drains, ready_timeout: float):
        """Wait for the host app's RPC bridge, coarsen the quantum now that the
        encrypted link is up, and return a PerfRpcDriver bound to the bridge.

        `drains` are (name, socket) pairs nobody else reads -- handing them to the
        bridge is what keeps the emulated consoles from back-pressuring and
        stalling the BLE stack mid-stream (see BleRpcBridge.attach_drain).
        """
        bridge = getattr(session, "host_bridge", None)
        if bridge is None:
            raise unittest.SkipTest(
                "this zmk-west-commands has no renode-ble-host RPC bridge "
                "(session.host_bridge is None) -- BLE perf needs the S7 bridge"
            )
        for name, sock in drains:
            bridge.attach_drain(sock, name)
        print(
            "[perf] waiting for the BLE link + RPC bridge (emulated pairing is slow)...",
            file=sys.stderr,
        )
        t0 = time.monotonic()
        try:
            bridge.wait_ready(timeout=ready_timeout)
        except TimeoutError:
            raise AssertionError(
                "the renode-ble-host never reached BRIDGE:READY within "
                f"{ready_timeout:.0f}s (emulated-radio pairing flake or a real "
                "regression). Host console tail:\n"
                f"{_console_tail(bridge.drained.get('host_console', ''))}"
            )
        print(
            f"[perf] BLE RPC bridge ready after {time.monotonic() - t0:.0f}s wall",
            file=sys.stderr,
        )
        driver = PerfRpcDriver(bridge, self.studio_pb2, self.perf_pb2)
        driver.discover_subsystem(timeout=BLE_RPC_TIMEOUT)
        return driver

    @staticmethod
    def _close_bridge(session):
        bridge = getattr(session, "host_bridge", None)
        if bridge is not None:
            bridge.close()

    # -- shared USB attach --------------------------------------------------

    def _attach_usb_studio(self, session, console, port_base, machines=None):
        """Settle the guest's USB init, attach the DualCdcAcmBridge, and return
        the Studio CDC socket (auto-detecting a possible console CDC first).

        `machines` must name every machine (USB one first) on a multi-machine
        emulation -- the attach's pause is machine-scoped, and leaving a BLE peer
        running while the central is frozen drops the split link.
        """
        mon = session.mon
        assert mon is not None
        t0 = time.monotonic()
        while time.monotonic() - t0 < BOOT_SETTLE:
            renode_harness.drain_text(console._sock, timeout=0.5)

        kwargs = {"machines": machines} if machines is not None else {}
        cdc = list(
            renode_harness.attach_dual_cdc_bridge(
                session, port_base + 4, port_base + 5, **kwargs
            )
        )
        self._cdc_sockets = cdc

        deadline = time.monotonic() + WIRING_TIMEOUT
        while time.monotonic() < deadline:
            if _mon_flag(mon, f"sysbus.{USB_BRIDGE_NAME}_cdc0 IsWired"):
                break
        else:
            raise AssertionError(
                "USB enumeration never wired the first CDC channel -- is the DUT a "
                "studio-rpc-usb-uart (USB-CDC) image?"
            )
        dual_cdc = bool(_mon_flag(mon, f"sysbus.{USB_BRIDGE_NAME}_cdc1 IsWired"))
        # Let the bridge finish its post-wiring control sequence (SET_LINE_CODING /
        # DTR) and arm the device->host pumps.
        time.sleep(2.0)
        # With a console CDC present it enumerates first, Studio second.
        return cdc[1] if dual_cdc else cdc[0]


if __name__ == "__main__":
    unittest.main()
