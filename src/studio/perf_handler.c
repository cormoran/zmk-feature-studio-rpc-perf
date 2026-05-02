/**
 * Performance Feature - Custom Studio RPC Handler
 *
 * Registers a custom RPC subsystem "zmk__perf" that echoes back a
 * caller-specified number of payload bytes so the web UI can measure
 * round-trip latency, throughput, and packet-loss rate.
 */

#include <string.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zmk/studio/custom.h>
#include <zmk/perf/perf.pb.h>

#include <zephyr/logging/log.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

static struct zmk_rpc_custom_subsystem_meta perf_feature_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("http://localhost:5173"),
    .security = ZMK_STUDIO_RPC_HANDLER_UNSECURED,
};

ZMK_RPC_CUSTOM_SUBSYSTEM(zmk__perf, &perf_feature_meta, perf_rpc_handle_request);

ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(zmk__perf, zmk_perf_Response);

static int handle_perf_request(const zmk_perf_PerfRequest *req, zmk_perf_Response *resp);

static bool perf_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                    pb_callback_t *encode_response) {
    zmk_perf_Response *resp =
        ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(zmk__perf, encode_response);

    zmk_perf_Request req = zmk_perf_Request_init_zero;

    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);
    if (!pb_decode(&req_stream, zmk_perf_Request_fields, &req)) {
        LOG_WRN("Failed to decode perf request: %s", PB_GET_ERROR(&req_stream));
        zmk_perf_ErrorResponse err = zmk_perf_ErrorResponse_init_zero;
        snprintf(err.message, sizeof(err.message), "Failed to decode request");
        resp->which_response_type = zmk_perf_Response_error_tag;
        resp->response_type.error = err;
        return true;
    }

    int rc = 0;
    switch (req.which_request_type) {
    case zmk_perf_Request_perf_tag:
        rc = handle_perf_request(&req.request_type.perf, resp);
        break;
    default:
        LOG_WRN("Unsupported perf request type: %d", req.which_request_type);
        rc = -1;
    }

    if (rc != 0) {
        zmk_perf_ErrorResponse err = zmk_perf_ErrorResponse_init_zero;
        snprintf(err.message, sizeof(err.message), "Failed to process request");
        resp->which_response_type = zmk_perf_Response_error_tag;
        resp->response_type.error = err;
    }
    return true;
}

static int handle_perf_request(const zmk_perf_PerfRequest *req, zmk_perf_Response *resp) {
    LOG_DBG("Received perf request: seq=%u response_size=%u request_data_len=%zu",
            req->sequence_number, req->response_size, req->data.size);

    zmk_perf_PerfResponse result = zmk_perf_PerfResponse_init_zero;

    result.sequence_number = req->sequence_number;

    uint32_t data_size = req->response_size;
    if (data_size > sizeof(result.data.bytes)) {
        data_size = sizeof(result.data.bytes);
    }
    memset(result.data.bytes, 0xAA, data_size);
    result.data.size = data_size;

    resp->which_response_type = zmk_perf_Response_perf_tag;
    resp->response_type.perf = result;
    return 0;
}
