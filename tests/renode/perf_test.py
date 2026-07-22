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
  * ble / ble-split -- SKIPPED. The renode-ble-host app only pairs and does a
                   GetDeviceInfo / encrypted GATT read; a *custom* subsystem RPC
                   is not drivable from the Python test harness over BLE yet
                   (a zmk-west-commands limitation, tracked upstream). ble mode
                   still proves the perf-enabled image boots and answers core
                   Studio over BLE via the generic smoke.

The env contract (ZMK_RENODE_MODE / _ELF / _PERIPHERAL_ELF / _STORAGE_*) is set
by `west zmk-renode-test`; see docs/renode-testing.md in zmk-west-commands.
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
ELF = os.environ.get("ZMK_RENODE_ELF", "")
PERIPHERAL_ELF = os.environ.get("ZMK_RENODE_PERIPHERAL_ELF", "")
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

RPC_TIMEOUT = 15.0
BOOT_SETTLE = 8.0
WIRING_TIMEOUT = 30.0
BOOT_TIMEOUT = 20.0
# One whole-emulation retry (the run_usb_smoke pattern): a fresh boot re-rolls
# the wall-clock-paced USB attach, which can lose a race under heavy CI host
# contention. A genuine break fails BOTH attempts.
MAX_ATTEMPTS = 2


def _storage_kwargs() -> dict:
    kw = {}
    if STORAGE_ADDR is not None:
        kw["storage_addr"] = STORAGE_ADDR
    if STORAGE_SIZE is not None:
        kw["storage_size"] = STORAGE_SIZE
    return kw


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


def _assert_stream(driver: PerfRpcDriver, iterations: int, split: bool):
    """Drive `iterations` perf round trips (rotating response sizes) and assert
    every one echoes its sequence number, returns exactly response_size bytes,
    and matches the expected split flag. Returns the list of PerfResponses."""
    responses = []
    for i in range(iterations):
        seq = 0x1000 + i
        response_size = RESPONSE_SIZES[i % len(RESPONSE_SIZES)]
        perf = driver.perf_roundtrip(seq, response_size, split)

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

    def _run_with_retry(self, attempt):
        """Run `attempt` (a fresh-boot callable) with one whole-emulation retry
        on a transport/boot flake; re-raise the last error if both fail."""
        last_err: Exception | None = None
        for n in range(1, MAX_ATTEMPTS + 1):
            if n > 1:
                print(
                    f"[perf] --- retry {n}/{MAX_ATTEMPTS} (fresh emulation; "
                    "previous attempt flaked) ---",
                    file=sys.stderr,
                )
            try:
                attempt()
                return
            except (AssertionError, TimeoutError, OSError) as err:
                last_err = err
                print(
                    f"[perf] attempt {n}/{MAX_ATTEMPTS} FAILED: {err!r}",
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

    # -- shared USB attach --------------------------------------------------

    def _attach_usb_studio(self, session, console, port_base):
        """Settle the guest's USB init, attach the DualCdcAcmBridge, and return
        the Studio CDC socket (auto-detecting a possible console CDC first)."""
        mon = session.mon
        assert mon is not None
        t0 = time.monotonic()
        while time.monotonic() - t0 < BOOT_SETTLE:
            renode_harness.drain_text(console._sock, timeout=0.5)

        cdc = list(
            renode_harness.attach_dual_cdc_bridge(session, port_base + 4, port_base + 5)
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
