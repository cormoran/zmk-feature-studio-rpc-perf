#!/usr/bin/env python3
"""Headless Renode transport benchmark for the zmk__perf custom Studio RPC.

For one transport PATH (uart | usb-single | usb-dual) this boots a perf image
under Renode, queries the build's payload limits once (SettingsRequest), then
sweeps the perf echo SIZE upward -- both the response_size (device->host / TX
path) and the request data padding (host->device / RX path) -- measuring, per
size over N repeats: round-trip latency (min/mean/median/p95/max) and stability
(success rate + dominant failure reason: timeout/loss, ErrorResponse, or a
partial-frame stall where bytes start flowing but the frame never closes).

Reuses the zmk-west-commands Renode harness (boot_single for uart;
boot_single_real + attach_dual_cdc_bridge for usb) and the perf_framing codec.

Outputs (under --out-dir):
  <path>_raw.csv       one row per individual request
  <path>_summary.csv   one row per (path, sweep, size)
  <path>_result.json   settings + summary, machine-readable

NOT a pytest/unittest target and NOT wired into CI (see PR). Run one path at a
time (serialize -- only one Renode instance at a time). Example:
  python3 tests/renode/perf_sweep.py --path uart \
      --elf build/perf_uart/zephyr/zmk.elf --out-dir tests/renode/results
"""

from __future__ import annotations

import argparse
import csv
import json
import socket
import statistics
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import perf_framing  # noqa: E402

rh = perf_framing._find_renode_harness()

SOF, ESC, EOF = 0xAB, 0xAC, 0xAD

# xiao_ble//zmk links its image at the Adafruit-UF2 bootloader partition
# (CONFIG_FLASH_LOAD_OFFSET), so the Cortex-M reset vector lives there, NOT at
# 0x0. Renode's `sysbus LoadELF` sets the entry PC but the CPU still resets via
# VTOR=0 (empty flash -> PC=0, dead boot); the harness boot_single/_real work
# only by luck. Setting VectorTableOffset to the load offset before `start`
# makes the reset read the real SP/PC and boot deterministically. Verified: the
# known-good renode_tester control image is silent without this and prints
# "Welcome to ZMK" with it.
FLASH_LOAD_OFFSET = 0x27000

DEFAULT_RESPONSE_SIZES = [
    0,
    8,
    16,
    24,
    28,
    30,
    31,
    32,
    40,
    48,
    64,
    96,
    128,
    192,
    256,
    384,
    512,
    768,
    1024,
    1536,
    2048,
]
# Request(RX)-path sweep: pad the request `data`, hold the response tiny (8B) so
# only the host->device direction grows.
DEFAULT_REQUEST_SIZES = [
    0,
    8,
    16,
    24,
    28,
    30,
    31,
    32,
    40,
    48,
    64,
    96,
    128,
    192,
    256,
    384,
    512,
    768,
    1024,
    1536,
    2048,
]


# --------------------------------------------------------------------------
# Raw framed read with stall diagnostics (distinguishes loss vs partial stall).
# --------------------------------------------------------------------------
def read_perf_response(sock, codec, expected_seq, timeout):
    """Read Studio frames off `sock` until the matching perf Response arrives.

    Returns a dict: {status, message, bytes_seen, mid_frame}. status is one of:
      "perf"     -> matching perf echo (message = perf sub-message)
      "error"    -> ErrorResponse (message = error sub-message)
      "settings" -> SettingsResponse (message = settings sub-message)
      "timeout"  -> no matching frame before deadline. bytes_seen = total raw
                    bytes read; mid_frame = True if a SOF was seen with payload
                    bytes but no closing EOF (a partial-frame TX stall).
    """
    deadline = time.monotonic() + timeout
    rx = bytearray()
    in_frame = escaped = False
    cur = bytearray()
    bytes_seen = 0
    saw_partial = False

    def try_frame(payload):
        kind, msg = codec.decode_response(bytes(payload))
        if kind == "perf" and msg.sequence_number == expected_seq:
            return {"status": "perf", "message": msg}
        if kind == "error":
            return {"status": "error", "message": msg}
        if kind == "settings":
            return {"status": "settings", "message": msg}
        return None  # unsolicited (e.g. lock-state) -- keep reading

    while time.monotonic() < deadline:
        sock.settimeout(0.2)
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            continue
        except OSError:
            break
        if not chunk:
            break
        bytes_seen += len(chunk)
        rx.extend(chunk)
        while rx:
            b = rx.pop(0)
            if not in_frame:
                if b == SOF:
                    in_frame = True
                    cur = bytearray()
                continue
            if escaped:
                cur.append(b)
                escaped = False
            elif b == ESC:
                escaped = True
            elif b == EOF:
                in_frame = False
                got = try_frame(cur)
                if got is not None:
                    got["bytes_seen"] = bytes_seen
                    got["mid_frame"] = False
                    return got
            elif b == SOF:
                cur = bytearray()
            else:
                cur.append(b)
        if in_frame and len(cur) > 0:
            saw_partial = True

    return {
        "status": "timeout",
        "message": None,
        "bytes_seen": bytes_seen,
        "mid_frame": bool(in_frame and len(cur) > 0) or saw_partial,
    }


# --------------------------------------------------------------------------
# Session wrapper: owns one Renode boot + the Studio socket for a path.
# --------------------------------------------------------------------------
class PathSession:
    def __init__(
        self, path, elf, renode, codec=None, boot_settle=8.0, boot_timeout=20.0
    ):
        self.path = path
        # MUST be absolute: Renode runs with cwd=SKILL_DIR (the harness dir), so a
        # relative `@bin` path would resolve there and LoadELF would silently fail
        # (the vector table never populates -> "image did not load").
        self.elf = Path(elf).resolve()
        self.renode = renode
        self.codec = codec  # used to auto-detect the Studio USB CDC channel
        self.boot_settle = boot_settle
        self.boot_timeout = boot_timeout
        self.session = None
        self.studio = None
        self._extra_socks = []
        self.dual_cdc = None

    def _port_base(self):
        import random

        return random.randint(26000, 40000)

    def boot(self):
        if self.path == "uart":
            self._boot_uart()
        elif self.path in ("usb-single", "usb-dual"):
            self._boot_usb()
        else:
            raise ValueError(f"unknown path {self.path}")

    @staticmethod
    def _cpu_pc(mon):
        import re as _re

        s = _re.sub(r"\x1b\[[0-9;]*m", "", mon.execute("sysbus.cpu PC", settle=0.25))
        for line in s.split("\n"):
            line = line.strip("\r ")
            if line.startswith("0x"):
                return int(line, 16)
        return None

    @classmethod
    def _prime_cpu(cls, session):
        """Prime the Cortex-M for the bootloader-offset image, BEFORE `start`.

        Two gotchas, both handled here:
          1. single.resc / single_real.resc run `sysbus LoadELF` as their LAST
             line, AFTER the socket terminals -- so connect_uart() returning does
             NOT mean LoadELF has finished. Priming before LoadELF completes lets
             LoadELF clobber the primed state -> dead boot (PC=0). So we first
             poll PC until it is non-zero (== the entry LoadELF set), confirming
             LoadELF ran.
          2. The image links at the Adafruit-UF2 bootloader offset
             (FLASH_LOAD_OFFSET), so the reset vector is there, not at 0x0. We
             point VTOR at the offset; `start` then resets via VTOR to the real
             SP/PC. (A manual `cpu PC`/`cpu SP` write is deliberately avoided --
             it boots but leaves the CPU mis-initialised so the interrupt-driven
             Studio UART RX never comes up.)"""
        import re as _re

        assert session.mon is not None
        mon = session.mon

        def rdw(addr):
            s = _re.sub(
                r"\x1b\[[0-9;]*m", "", mon.execute(f"sysbus ReadDoubleWord {hex(addr)}")
            )
            for line in s.split("\n"):
                line = line.strip("\r ")
                if line.startswith("0x"):
                    return int(line, 16)
            return None

        # LoadELF fills flash; before it runs the vector word reads 0 (zero-filled
        # MappedMemory). PC reads 0 until `start`, so it cannot gate this -- poll
        # the initial-SP vector word instead.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if rdw(FLASH_LOAD_OFFSET):  # non-zero initial SP -> LoadELF done
                break
            time.sleep(0.2)
        else:
            raise RuntimeError(
                "LoadELF never populated the vector table (image did not load)"
            )
        mon.execute(f"sysbus.cpu VectorTableOffset {hex(FLASH_LOAD_OFFSET)}")

    def _verify_live(self):
        """After go(): confirm the guest CPU is actually executing (non-zero PC),
        so a dead boot (PC stuck at 0) is caught here and retried by the caller."""
        mon = self.session.mon
        time.sleep(1.2)
        pc = self._cpu_pc(mon)
        if not pc:
            raise RuntimeError(f"guest CPU not executing after start (pc={pc})")

    @staticmethod
    def _fast_monitor(session, timeout=0.5):
        """Lower the monitor socket drain timeout so simple, instant-reply
        commands (PC/memory reads, VectorTableOffset) don't each cost the default
        2 s drain -- cuts boot wall time roughly in half. Only safe for commands
        whose reply is immediate and whose completion isn't awaited via the drain
        (LoadELF etc. are done in the .resc, not over this monitor)."""
        try:
            session.mon.sock.settimeout(timeout)
        except Exception:
            pass

    def _boot_uart(self):
        # Replicate rh.boot_single but inject VectorTableOffset before `start`
        # (see FLASH_LOAD_OFFSET note).
        from renode_harness import RenodeSession, PLATFORMS_DIR, SKILL_DIR

        pb = self._port_base()
        session = RenodeSession(
            self.renode,
            PLATFORMS_DIR / "single.resc",
            monitor_port=pb,
            variables={
                "bin": f"@{self.elf}",
                "console_port": pb + 1,
                "rpc_port": pb + 2,
            },
            cwd=SKILL_DIR,
        )
        session.start(boot_wait=3.0)
        self._fast_monitor(session)  # speed up the many small monitor commands
        console = session.connect_uart(pb + 1)
        rpc = session.connect_uart(pb + 2)
        self._prime_cpu(session)
        session.go()
        self.session = session
        self._verify_live()
        self._extra_socks = [console, rpc]
        # Readiness is verified by an RPC probe in Sweeper._ensure_booted (a tiny
        # response_size=0 echo), not the console banner: this image floods the
        # console with kscan <dbg> lines at boot and the "Welcome to ZMK" INF
        # line can be dropped from the deferred log ring.
        self.studio = rpc

    def _boot_usb(self):
        # Replicate rh.boot_single_real (usb repl variant) but inject
        # VectorTableOffset before `start` and before the NVS 0xFF preload.
        import os

        from renode_harness import (
            RenodeSession,
            PLATFORMS_DIR,
            SKILL_DIR,
            STORAGE_ADDR_DEFAULT,
            STORAGE_SIZE_DEFAULT,
            _materialize_real_repl,
            _write_ff_binary,
        )

        pb = self._port_base()
        repl_path = _materialize_real_repl(None, template_name="xiao_nrf52840_usb.repl")
        ff_path = _write_ff_binary(STORAGE_SIZE_DEFAULT)
        session = RenodeSession(
            self.renode,
            PLATFORMS_DIR / "single_real.resc",
            monitor_port=pb,
            variables={
                "bin": f"@{self.elf}",
                "console_port": pb + 1,
                "rpc_port": pb + 2,
                "platform": f"@{repl_path}",
            },
            cwd=SKILL_DIR,
        )
        session.rtt_socket = None
        try:
            session.start(boot_wait=3.0)
            console = session.connect_uart(pb + 1)
            rpc = session.connect_uart(pb + 2)
            self._prime_cpu(session)
            session.mon.execute(
                f"sysbus LoadBinary @{ff_path} {hex(STORAGE_ADDR_DEFAULT)}"
            )
            session.go()
        finally:
            for tmp in (repl_path, ff_path):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        self.session = session
        self._verify_live()
        self._extra_socks = [console, rpc]
        # Let the guest finish USB bring-up before attaching the host bridge.
        t0 = time.monotonic()
        while time.monotonic() - t0 < self.boot_settle:
            rh.drain_text(console._sock, timeout=0.5)
        cdc0, cdc1 = rh.attach_dual_cdc_bridge(session, pb + 4, pb + 5)
        self._extra_socks += [cdc0, cdc1]
        mon = session.mon
        import re

        def flag(cmd):
            text = re.sub(r"\x1b\[[0-9;]*m", "", mon.execute(cmd, settle=0.3))
            for line in text.splitlines():
                line = line.strip()
                if line in ("True", "False"):
                    return line == "True"
            return None

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if flag("sysbus.bridge_cdc0 IsWired"):
                break
        else:
            raise RuntimeError(
                "usb: enumeration never wired cdc0 (is the ELF a USB-CDC image?)"
            )
        self.dual_cdc = bool(flag("sysbus.bridge_cdc1 IsWired"))
        time.sleep(2.0)
        if self.path == "usb-dual" and not self.dual_cdc:
            raise RuntimeError(
                "usb-dual: only one CDC found (build lacks zmk-usb-logging?)"
            )
        if self.path == "usb-single" and self.dual_cdc:
            raise RuntimeError(
                "usb-single: two CDCs found (build has zmk-usb-logging?)"
            )
        # Which CDC carries Studio RPC is NOT fixed by convention -- for this
        # module's dual build the Studio CDC enumerates as cdc0 and the console as
        # cdc1 (the reverse of the zmk-west-commands smoke's assumption). Probe to
        # find the channel that actually answers a perf request.
        candidates = [cdc0, cdc1] if self.dual_cdc else [cdc0]
        self.studio = self._detect_studio_channel(candidates)

    def _detect_studio_channel(self, candidates):
        """Return the CDC socket that answers a minimal perf request. Falls back
        to the first candidate if none answers within the probe window (so
        _ensure_booted's readiness check reports the failure rather than here)."""
        if self.codec is None or len(candidates) == 1:
            return candidates[0]
        for cand in candidates:
            sock = cand._sock
            sock.settimeout(0.02)
            try:
                while sock.recv(4096):
                    pass
            except OSError:
                pass
            cand.send(self.codec.perf_request(1, 0xABC, response_size=0))
            res = read_perf_response(sock, self.codec, 0xABC, timeout=3.0)
            if res["status"] == "perf":
                return cand
        return candidates[0]

    @staticmethod
    def _kill_tree(pid):
        """Kill `pid` and all its descendants. RenodeSession.stop() kills only
        the launcher shell, orphaning the `renode`/mono child -- those pile up and
        starve later boots (resource contention -> LoadELF never completes). This
        walks the tree by PID so ONLY our own Renode is killed (never a foreign
        instance from another session)."""
        import os
        import signal
        import subprocess

        def children(p):
            try:
                out = subprocess.run(
                    ["pgrep", "-P", str(p)], capture_output=True, text=True
                ).stdout
                return [int(x) for x in out.split()]
            except Exception:
                return []

        tree, stack = [], [pid]
        while stack:
            p = stack.pop()
            tree.append(p)
            stack.extend(children(p))
        for p in reversed(tree):  # children before parents
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass

    def stop(self):

        for s in self._extra_socks:
            try:
                s.close()
            except Exception:
                pass
        # Kill the whole tree BEFORE session.stop(): stop() kills the launcher
        # shell, after which the renode/mono child is reparented to init and is no
        # longer discoverable as a descendant.
        if self.session is not None and self.session.proc is not None:
            self._kill_tree(self.session.proc.pid)
        if self.session is not None:
            try:
                self.session.stop()
            except Exception:
                pass
        self.session = None
        self.studio = None
        self._extra_socks = []


# --------------------------------------------------------------------------
# Sweep engine
# --------------------------------------------------------------------------
class Sweeper:
    def __init__(
        self,
        path,
        elf,
        renode,
        codec,
        repeats,
        timeout,
        recover=True,
        reboot_per_request=False,
    ):
        self.path = path
        self.elf = elf
        self.renode = renode
        self.codec = codec
        self.repeats = repeats
        self.timeout = timeout
        self.recover = recover
        # reboot_per_request: reboot before EVERY measurement so each rep is the
        # first RPC after a fresh boot. Required for the uart custom-RPC path,
        # whose TX ring wedges permanently after ~1 response under Renode -- so
        # only the first-response-after-boot is a meaningful per-size data point
        # (isolates the per-response ~30B stall from the cumulative wedge).
        self.reboot_per_request = reboot_per_request
        self.sess = None
        self._req_id = 0
        self._seq = 0
        self.raw_rows = []
        self.summaries = []
        self.out_dir = None  # set by main() to enable incremental CSV flushing

    RAW_FIELDS = ["path", "sweep", "size", "rep", "latency_ms", "status", "detail"]
    SUMM_FIELDS = [
        "path",
        "sweep",
        "size",
        "n",
        "ok",
        "success_rate",
        "dominant_failure",
        "failures",
        "lat_min_ms",
        "lat_mean_ms",
        "lat_median_ms",
        "lat_p95_ms",
        "lat_max_ms",
    ]

    def _flush_csvs(self):
        """Rewrite raw + summary CSVs from the accumulated rows (called per size
        so partial progress survives a kill and can be monitored live)."""
        if self.out_dir is None:
            return
        import csv as _csv

        with (self.out_dir / f"{self.path}_raw.csv").open("w", newline="") as f:
            w = _csv.DictWriter(f, fieldnames=self.RAW_FIELDS)
            w.writeheader()
            w.writerows(self.raw_rows)
        with (self.out_dir / f"{self.path}_summary.csv").open("w", newline="") as f:
            w = _csv.DictWriter(f, fieldnames=self.SUMM_FIELDS)
            w.writeheader()
            w.writerows(self.summaries)

    def _next_ids(self):
        self._req_id += 1
        self._seq += 1
        return self._req_id, self._seq

    def _wait_ready(self, tries=25, per_try_timeout=1.0):
        """Probe firmware readiness with a minimal response_size=0 echo (well
        under the ~30B UART stall) until it round-trips. Returns True if ready."""
        for _ in range(tries):
            lat, status, _ = self.one_request(response_size=0, request_size=0)
            if status == "ok":
                return True
            time.sleep(per_try_timeout)
        return False

    def _ensure_booted(self):
        if self.sess is None:
            for attempt in range(3):
                self.sess = PathSession(
                    self.path, self.elf, self.renode, codec=self.codec
                )
                try:
                    self.sess.boot()
                    if self._wait_ready():
                        return
                    print(
                        f"  boot attempt {attempt + 1}: booted but RPC never ready",
                        file=sys.stderr,
                    )
                except (RuntimeError, TimeoutError, OSError, BrokenPipeError) as e:
                    print(
                        f"  boot attempt {attempt + 1} failed: {e!r}", file=sys.stderr
                    )
                self.sess.stop()
                time.sleep(2.0)
                self.sess = None
            raise RuntimeError(f"{self.path}: could not boot after 3 attempts")

    def reboot(self):
        if self.sess is not None:
            self.sess.stop()
        self.sess = None
        self._ensure_booted()

    def _fresh_boot(self, tries=3):
        """Boot a fresh session WITHOUT the RPC readiness probe, so the next
        one_request is the very first RPC after boot (used by reboot_per_request
        -- the readiness probe would otherwise consume the one good response the
        wedging uart transport allows). Liveness is the CPU-executing check in
        PathSession.boot()."""
        if self.sess is not None:
            self.sess.stop()
        self.sess = None
        for attempt in range(tries):
            self.sess = PathSession(self.path, self.elf, self.renode, codec=self.codec)
            try:
                self.sess.boot()
                return
            except (RuntimeError, TimeoutError, OSError, BrokenPipeError) as e:
                print(
                    f"  fresh-boot attempt {attempt + 1} failed: {e!r}",
                    file=sys.stderr,
                    flush=True,
                )
                self.sess.stop()
                time.sleep(2.0)
                self.sess = None
        raise RuntimeError(f"{self.path}: could not fresh-boot after {tries} attempts")

    def one_request(self, response_size, request_size):
        """Single round trip; returns (latency_ms_or_None, status, detail)."""
        req_id, seq = self._next_ids()
        payload = self.codec.perf_request(
            req_id, seq, response_size=response_size, request_data_size=request_size
        )
        sock = self.sess.studio._sock
        # drain any stale bytes so a prior notification doesn't taint timing
        sock.settimeout(0.02)
        try:
            while True:
                if not sock.recv(4096):
                    break
        except OSError:
            pass
        t0 = time.perf_counter()
        try:
            self.sess.studio.send(payload)
        except (OSError, BrokenPipeError) as e:
            return None, "send_error", repr(e)
        res = read_perf_response(sock, self.codec, seq, self.timeout)
        t1 = time.perf_counter()
        if res["status"] == "perf":
            got = len(res["message"].data)
            detail = "" if got == min(response_size, 2048) else f"data_len={got}"
            return (t1 - t0) * 1000.0, "ok", detail
        if res["status"] == "error":
            return None, "error", res["message"].message
        # timeout / stall
        if res["bytes_seen"] == 0:
            return None, "timeout_no_bytes", "no bytes received"
        if res["mid_frame"]:
            return (
                None,
                "partial_frame_stall",
                f"{res['bytes_seen']}B seen, frame never closed",
            )
        return (
            None,
            "no_matching_frame",
            f"{res['bytes_seen']}B seen, no matching perf frame",
        )

    def _recover_ok(self):
        """Sanity ping at the always-safe size (resp=0, well under the stall);
        True if the firmware still answers."""
        lat, status, _ = self.one_request(response_size=0, request_size=0)
        return status == "ok"

    def sweep(self, sweep_name, sizes, is_request_sweep, early_stop_after=3):
        """Run one sweep; returns list of summary dicts and appends raw rows.

        Sizes are swept in ascending order. Recovery/reboot is done at most once
        per size (after its N repeats), not per repeat, to avoid reboot thrash on
        a wedged transport. After `early_stop_after` consecutive fully-failed
        sizes the ascending sweep stops early (larger sizes only fail harder);
        the untested larger sizes are emitted as rows with status "skipped"."""
        self._ensure_booted()
        summaries = []
        consecutive_zero = 0
        stopped = False
        for size in sizes:
            if stopped:
                sk = self._skipped_summary(sweep_name, size)
                summaries.append(sk)
                self.summaries.append(sk)
                self._flush_csvs()
                continue
            lats = []
            statuses = {}
            for rep in range(self.repeats):
                if is_request_sweep:
                    resp, reqs = 8, size
                else:
                    resp, reqs = size, 0
                if self.reboot_per_request:
                    # Fresh boot so this is the first RPC after boot (see the
                    # reboot_per_request note); a boot failure is retried, not
                    # counted as a transport data point.
                    try:
                        self._fresh_boot()
                    except RuntimeError as e:
                        print(
                            f"    [{sweep_name} size={size} rep={rep}] boot failed: {e!r}",
                            file=sys.stderr,
                            flush=True,
                        )
                        continue
                lat, status, detail = self.one_request(resp, reqs)
                self.raw_rows.append(
                    {
                        "path": self.path,
                        "sweep": sweep_name,
                        "size": size,
                        "rep": rep,
                        "latency_ms": f"{lat:.3f}" if lat is not None else "",
                        "status": status,
                        "detail": detail,
                    }
                )
                statuses[status] = statuses.get(status, 0) + 1
                if lat is not None:
                    lats.append(lat)
            n = self.repeats
            ok = statuses.get("ok", 0)
            fail_reasons = {k: v for k, v in statuses.items() if k != "ok"}
            dominant = max(fail_reasons, key=fail_reasons.get) if fail_reasons else ""
            summary = {
                "path": self.path,
                "sweep": sweep_name,
                "size": size,
                "n": n,
                "ok": ok,
                "success_rate": round(ok / n, 3),
                "dominant_failure": dominant,
                "failures": json.dumps(fail_reasons) if fail_reasons else "",
                "lat_min_ms": round(min(lats), 3) if lats else "",
                "lat_mean_ms": round(statistics.mean(lats), 3) if lats else "",
                "lat_median_ms": round(statistics.median(lats), 3) if lats else "",
                "lat_p95_ms": round(_p95(lats), 3) if lats else "",
                "lat_max_ms": round(max(lats), 3) if lats else "",
            }
            summaries.append(summary)
            self.summaries.append(summary)
            self._flush_csvs()
            print(
                f"  [{sweep_name}] size={size:<5} ok={ok}/{n} "
                f"rate={summary['success_rate']:<5} "
                f"median={summary['lat_median_ms']}ms "
                f"fail={dominant}",
                file=sys.stderr,
                flush=True,
            )
            # Once per size: if this size fully failed, the transport may be
            # wedged -- recover (reboot if a sanity ping cannot round-trip) so the
            # next size / sweep starts from a clean firmware state.
            if ok == 0:
                consecutive_zero += 1
                # In reboot_per_request mode every rep already booted fresh, so no
                # wedge-recovery reboot is needed (nor a sanity ping that would
                # itself just reboot).
                if (
                    not self.reboot_per_request
                    and self.recover
                    and not self._recover_ok()
                ):
                    print(
                        f"    transport wedged after size={size}; rebooting",
                        file=sys.stderr,
                        flush=True,
                    )
                    self.reboot()
                if consecutive_zero >= early_stop_after:
                    print(
                        f"  [{sweep_name}] early-stop: {consecutive_zero} consecutive "
                        f"fully-failed sizes; skipping larger sizes",
                        file=sys.stderr,
                        flush=True,
                    )
                    stopped = True
            else:
                consecutive_zero = 0
        return summaries

    def _skipped_summary(self, sweep_name, size):
        self.raw_rows.append(
            {
                "path": self.path,
                "sweep": sweep_name,
                "size": size,
                "rep": 0,
                "latency_ms": "",
                "status": "skipped",
                "detail": "early-stop",
            }
        )
        return {
            "path": self.path,
            "sweep": sweep_name,
            "size": size,
            "n": 0,
            "ok": 0,
            "success_rate": "",
            "dominant_failure": "skipped",
            "failures": "",
            "lat_min_ms": "",
            "lat_mean_ms": "",
            "lat_median_ms": "",
            "lat_p95_ms": "",
            "lat_max_ms": "",
        }

    def query_settings(self):
        # On the wedging uart path, boot fresh so the settings request is a clean
        # first RPC (a readiness probe would consume the one good response).
        if not self.reboot_per_request:
            self._ensure_booted()
        for _ in range(3):
            if self.reboot_per_request:
                self._fresh_boot()  # clean first-RPC each attempt
            req_id, _ = self._next_ids()
            payload = self.codec.settings_request(req_id)
            sock = self.sess.studio._sock
            self.sess.studio.send(payload)
            res = read_perf_response(
                sock, self.codec, expected_seq=-1, timeout=self.timeout
            )
            if res["status"] == "settings":
                m = res["message"]
                return {
                    "studio_rpc_rx_buf_size": m.studio_rpc_rx_buf_size,
                    "studio_rpc_tx_buf_size": m.studio_rpc_tx_buf_size,
                    "custom_subsystem_request_payload_max_bytes": (
                        m.custom_subsystem_request_payload_max_bytes
                    ),
                    "perf_request_data_max_bytes": m.perf_request_data_max_bytes,
                    "perf_response_data_max_bytes": m.perf_response_data_max_bytes,
                    "split_relay_enabled": m.split_relay_enabled,
                    "split_relay_event_data_len": m.split_relay_event_data_len,
                }
            time.sleep(0.5)
        return None

    def stop(self):
        if self.sess is not None:
            self.sess.stop()
            self.sess = None


def _p95(values):
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, int(round(0.95 * (len(s) - 1))))
    return s[idx]


def breakpoint_size(summaries, threshold=0.95):
    """Largest size (in ascending order) with success_rate >= threshold, before
    the first size that drops below it (the reliably-working ceiling)."""
    last_good = None
    for s in sorted(summaries, key=lambda r: r["size"]):
        rate = s["success_rate"]
        if not isinstance(rate, (int, float)):
            break  # skipped (early-stop) -> nothing reliable beyond here
        if rate >= threshold:
            last_good = s["size"]
        else:
            break
    return last_good


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--path", required=True, choices=["uart", "usb-single", "usb-dual"])
    ap.add_argument("--elf", required=True)
    ap.add_argument(
        "--out-dir", default=str(Path(__file__).resolve().parent / "results")
    )
    ap.add_argument("--repeats", type=int, default=20)
    ap.add_argument("--timeout", type=float, default=4.0)
    ap.add_argument("--response-sizes", help="comma-separated override")
    ap.add_argument("--request-sizes", help="comma-separated override")
    ap.add_argument("--renode", help="renode launcher path (auto if omitted)")
    ap.add_argument(
        "--no-recover", action="store_true", help="disable wedge auto-reboot"
    )
    ap.add_argument(
        "--reboot-per-request",
        choices=["auto", "on", "off"],
        default="auto",
        help="reboot before every measurement (each rep = first RPC after boot). "
        "'auto' = on for uart (its TX ring wedges after ~1 response under Renode), "
        "off for usb.",
    )
    args = ap.parse_args(argv)

    renode = args.renode or rh.find_or_install_renode()
    if not renode:
        print("Renode not available", file=sys.stderr)
        return 2
    elf = Path(args.elf)
    if not elf.is_file():
        print(f"ELF not found: {elf}", file=sys.stderr)
        return 2

    studio_pb2, custom_pb2, perf_pb2 = perf_framing.load_protos(rh)
    codec = perf_framing.PerfCodec(studio_pb2, custom_pb2, perf_pb2)

    resp_sizes = (
        [int(x) for x in args.response_sizes.split(",")]
        if args.response_sizes
        else DEFAULT_RESPONSE_SIZES
    )
    req_sizes = (
        [int(x) for x in args.request_sizes.split(",")]
        if args.request_sizes
        else DEFAULT_REQUEST_SIZES
    )

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.reboot_per_request == "auto":
        reboot_per_request = args.path == "uart"
    else:
        reboot_per_request = args.reboot_per_request == "on"

    sweeper = Sweeper(
        args.path,
        elf,
        renode,
        codec,
        args.repeats,
        args.timeout,
        recover=not args.no_recover,
        reboot_per_request=reboot_per_request,
    )
    sweeper.out_dir = out_dir  # enable per-size incremental CSV flushing
    result_reboot_mode = reboot_per_request
    wall0 = time.time()
    result = {
        "path": args.path,
        "elf": str(elf),
        "repeats": args.repeats,
        "reboot_per_request": result_reboot_mode,
    }
    try:
        print(f"[{args.path}] booting + querying settings...", file=sys.stderr)
        settings = sweeper.query_settings()
        result["settings"] = settings
        # Persist settings immediately so they survive a mid-sweep kill.
        (out_dir / f"{args.path}_result.json").write_text(json.dumps(result, indent=2))
        print(f"[{args.path}] settings: {settings}", file=sys.stderr)

        print(f"[{args.path}] response-size (TX) sweep...", file=sys.stderr)
        resp_summ = sweeper.sweep("response_size", resp_sizes, is_request_sweep=False)
        print(f"[{args.path}] request-data (RX) sweep...", file=sys.stderr)
        req_summ = sweeper.sweep("request_data", req_sizes, is_request_sweep=True)
    finally:
        sweeper.stop()

    all_summ = resp_summ + req_summ
    result["response_size_breakpoint"] = breakpoint_size(resp_summ)
    result["request_data_breakpoint"] = breakpoint_size(req_summ)
    result["summary"] = all_summ
    result["wall_seconds"] = round(time.time() - wall0, 1)

    raw_csv = out_dir / f"{args.path}_raw.csv"
    with raw_csv.open("w", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "path",
                "sweep",
                "size",
                "rep",
                "latency_ms",
                "status",
                "detail",
            ],
        )
        w.writeheader()
        w.writerows(sweeper.raw_rows)

    summ_csv = out_dir / f"{args.path}_summary.csv"
    with summ_csv.open("w", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "path",
                "sweep",
                "size",
                "n",
                "ok",
                "success_rate",
                "dominant_failure",
                "failures",
                "lat_min_ms",
                "lat_mean_ms",
                "lat_median_ms",
                "lat_p95_ms",
                "lat_max_ms",
            ],
        )
        w.writeheader()
        w.writerows(all_summ)

    json_path = out_dir / f"{args.path}_result.json"
    json_path.write_text(json.dumps(result, indent=2))

    print(
        f"[{args.path}] DONE in {result['wall_seconds']}s. "
        f"TX breakpoint={result['response_size_breakpoint']} "
        f"RX breakpoint={result['request_data_breakpoint']}",
        file=sys.stderr,
    )
    print(
        f"  wrote {raw_csv}\n  wrote {summ_csv}\n  wrote {json_path}", file=sys.stderr
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
