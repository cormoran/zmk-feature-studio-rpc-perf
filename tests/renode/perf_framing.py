#!/usr/bin/env python3
"""Custom Studio-RPC framing helpers for the zmk__perf subsystem.

The perf feature (src/studio/perf_handler.c) registers a *custom* Studio RPC
subsystem, so a perf request/response rides INSIDE the Studio envelope:

    zmk.Request {
        request_id,
        custom { call { subsystem_index=0, payload = <zmk.perf.Request bytes> } }
    }

and the reply is a

    zmk.Response {
        request_response { custom { call { payload = <zmk.perf.Response bytes> } } }
    }

subsystem_index is 0 because the perf image registers exactly one custom
subsystem (the deterministic index-0 case, same as the pmw3610 module's Renode
test). This mirrors that proven pattern; see
zmk-driver-pmw3610-with-custom-studio-rpc/tests/renode/pmw3610_rpc_renode_test.py.

This module only builds/parses byte payloads; it does not touch Renode or
sockets, so it is import-safe from a plain unittest and reusable by any driver.
"""

from __future__ import annotations

import sys
from pathlib import Path

SUBSYSTEM_INDEX = 0  # single custom subsystem -> deterministic index 0

REPO_ROOT = Path(__file__).resolve().parents[2]


def _find_renode_harness():
    """Import renode_harness from PYTHONPATH or the vendored zmk-west-commands."""
    try:
        import renode_harness as rh  # noqa: F401

        return rh
    except ImportError:
        pass
    for cand in (
        REPO_ROOT / "dependencies" / "zmk-west-commands" / "scripts" / "lib" / "renode",
        REPO_ROOT.parent / "zmk-west-commands" / "scripts" / "lib" / "renode",
    ):
        if cand.is_dir():
            sys.path.insert(0, str(cand))
            import renode_harness as rh  # noqa: F401

            return rh
    raise ImportError(
        "renode_harness not found; run inside the west workspace "
        "(dependencies/zmk-west-commands must be present)"
    )


def load_protos(rh):
    """Compile + import (studio_pb2, custom_pb2, perf_pb2). `rh` is renode_harness.

    Mirrors the pmw3610 module's _load_protos(): studio messages first (gives
    studio_pb2 + custom_pb2 on sys.path), then the perf proto with the studio
    proto dir on the include path.
    """
    studio_proto_dir = rh.find_studio_proto_dir(REPO_ROOT)
    studio_pb2 = rh.load_studio_pb2(studio_proto_dir)
    import custom_pb2  # noqa: F401  (compiled alongside studio_pb2)

    rh.compile_protos(
        [REPO_ROOT / "proto" / "zmk" / "perf" / "perf.proto"],
        include_dirs=[REPO_ROOT / "proto", studio_proto_dir],
    )
    from zmk.perf import perf_pb2  # type: ignore

    return studio_pb2, custom_pb2, perf_pb2


class PerfCodec:
    """Encodes perf requests and decodes perf responses over the Studio envelope."""

    def __init__(self, studio_pb2, custom_pb2, perf_pb2):
        self.studio_pb2 = studio_pb2
        self.custom_pb2 = custom_pb2
        self.perf_pb2 = perf_pb2

    # -- encode ------------------------------------------------------------
    def _wrap(self, request_id: int, inner_bytes: bytes) -> bytes:
        req = self.studio_pb2.Request()
        req.request_id = request_id
        req.custom.call.subsystem_index = SUBSYSTEM_INDEX
        req.custom.call.payload = inner_bytes
        return req.SerializeToString()

    def perf_request(
        self,
        request_id: int,
        sequence_number: int,
        response_size: int,
        request_data_size: int = 0,
        split: bool = False,
    ) -> bytes:
        """Unframed zmk.Request bytes for a perf echo (RpcSocket.send adds the frame)."""
        perf = self.perf_pb2.Request()
        perf.perf.sequence_number = sequence_number
        perf.perf.response_size = response_size
        if request_data_size:
            perf.perf.data = b"\xbb" * request_data_size
        perf.perf.split = split
        return self._wrap(request_id, perf.SerializeToString())

    def settings_request(self, request_id: int = 1) -> bytes:
        perf = self.perf_pb2.Request()
        perf.settings.SetInParent()  # select the (empty) settings oneof arm
        return self._wrap(request_id, perf.SerializeToString())

    # -- decode ------------------------------------------------------------
    def decode_response(self, frame_payload: bytes):
        """Parse a Studio Response frame payload into the inner perf Response.

        Returns (kind, message) where kind is one of "perf", "settings",
        "error", or None if the frame is not a custom-call response we own
        (e.g. an unsolicited lock-state notification). `message` is the parsed
        perf_pb2 sub-message for perf/settings/error, else None.
        """
        resp = self.studio_pb2.Response()
        try:
            resp.ParseFromString(frame_payload)
        except Exception:
            return None, None
        if resp.WhichOneof("type") != "request_response":
            return None, None
        rr = resp.request_response
        if rr.WhichOneof("subsystem") != "custom":
            return None, None
        if rr.custom.WhichOneof("response_type") != "call":
            return None, None
        inner = self.perf_pb2.Response()
        try:
            inner.ParseFromString(rr.custom.call.payload)
        except Exception:
            return None, None
        kind = inner.WhichOneof("response_type")
        if kind == "perf":
            return "perf", inner.perf
        if kind == "settings":
            return "settings", inner.settings
        if kind == "error":
            return "error", inner.error
        return None, None
