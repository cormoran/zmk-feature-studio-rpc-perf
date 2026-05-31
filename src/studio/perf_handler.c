/**
 * Performance Feature - Custom Studio RPC Handler
 *
 * Registers a custom RPC subsystem "zmk__perf" that echoes back a
 * caller-specified number of payload bytes so the web UI can measure
 * round-trip latency, throughput, and packet-loss rate.
 */

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

#include <zmk/event_manager.h>

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)
#include <pb_decode.h>
#include <pb_encode.h>
#include <zmk/perf/perf.pb.h>
#include <zmk/studio/custom.h>
#endif

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY) &&                                      \
    IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
#include <zmk/split/central.h>
#endif

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#define PERF_MAX_DATA_SIZE 2048

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY)

struct zmk_perf_split_relay_request {
    uint8_t source;
    uint32_t sequence_number;
    uint16_t request_size;
    uint16_t response_size;
    uint16_t offset;
    uint8_t chunk_size;
    uint8_t data[CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE];
} __packed;

struct zmk_perf_split_relay_response {
    uint8_t source;
    uint32_t sequence_number;
    uint16_t response_size;
    uint16_t offset;
    uint8_t chunk_size;
    uint8_t data[CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE];
} __packed;

BUILD_ASSERT(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE <= UINT8_MAX,
             "CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE must fit in uint8_t");
BUILD_ASSERT(sizeof(struct zmk_perf_split_relay_request) <= CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN,
             "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN is too small for perf relay requests");
BUILD_ASSERT(sizeof(struct zmk_perf_split_relay_response) <= CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN,
             "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN is too small for perf relay responses");

ZMK_EVENT_DECLARE(zmk_perf_split_relay_request);
ZMK_EVENT_DECLARE(zmk_perf_split_relay_response);
ZMK_EVENT_IMPL(zmk_perf_split_relay_request);
ZMK_EVENT_IMPL(zmk_perf_split_relay_response);

ZMK_RELAY_EVENT_HANDLE(zmk_perf_split_relay_request, zpr, source);
ZMK_RELAY_EVENT_HANDLE(zmk_perf_split_relay_response, zps, source);
ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL(zmk_perf_split_relay_request, zpr, source);
ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL(zmk_perf_split_relay_response, zps, source);

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL) && IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)

static K_MUTEX_DEFINE(perf_split_response_mutex);
static K_SEM_DEFINE(perf_split_response_sem, 0, 1);

static struct {
    bool waiting;
    bool complete;
    uint32_t sequence_number;
    uint8_t source;
    uint16_t expected_size;
    uint16_t received_size;
    zmk_perf_PerfResponse response;
} perf_split_response_state;

static size_t perf_split_request_chunk_max(void) {
    return CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE;
}

static int perf_split_send_request(const zmk_perf_PerfRequest *req) {
    size_t max_chunk_size = perf_split_request_chunk_max();
    uint16_t request_size = req->data.size;
    uint16_t offset = 0;

    if (request_size > 0 && max_chunk_size == 0) {
        return -EMSGSIZE;
    }

    do {
        size_t remaining = request_size - offset;
        uint8_t chunk_size = MIN(max_chunk_size, remaining);
        struct zmk_perf_split_relay_request event = {
            .source = ZMK_RELAY_EVENT_SOURCE_SELF,
            .sequence_number = req->sequence_number,
            .request_size = request_size,
            .response_size = req->response_size,
            .offset = offset,
            .chunk_size = chunk_size,
        };

        memcpy(event.data, req->data.bytes + offset, chunk_size);
        int ret = raise_zmk_perf_split_relay_request(event);
        if (ret < 0) {
            return ret;
        }

        if (request_size == 0) {
            break;
        }

        offset += chunk_size;
    } while (offset < request_size);

    return 0;
}

static int perf_split_handle_response_event(const struct zmk_perf_split_relay_response *ev) {
    if (ev->chunk_size > sizeof(ev->data)) {
        LOG_WRN("Malformed split perf response chunk: chunk=%u", ev->chunk_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    k_mutex_lock(&perf_split_response_mutex, K_FOREVER);

    if (!perf_split_response_state.waiting ||
        perf_split_response_state.sequence_number != ev->sequence_number) {
        k_mutex_unlock(&perf_split_response_mutex);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (ev->response_size > sizeof(perf_split_response_state.response.data.bytes) ||
        ev->offset + ev->chunk_size > ev->response_size) {
        LOG_WRN("Invalid split perf response chunk: seq=%u size=%u offset=%u chunk=%u",
                ev->sequence_number, ev->response_size, ev->offset, ev->chunk_size);
        k_mutex_unlock(&perf_split_response_mutex);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (ev->offset == 0) {
        perf_split_response_state.expected_size = ev->response_size;
        perf_split_response_state.received_size = 0;
        perf_split_response_state.response = (zmk_perf_PerfResponse)zmk_perf_PerfResponse_init_zero;
        perf_split_response_state.response.sequence_number = ev->sequence_number;
        perf_split_response_state.response.split = true;
        perf_split_response_state.response.source = ev->source;
        perf_split_response_state.source = ev->source;
    }

    if (ev->chunk_size > 0) {
        memcpy(perf_split_response_state.response.data.bytes + ev->offset, ev->data,
               ev->chunk_size);
    }
    perf_split_response_state.received_size += ev->chunk_size;

    if (perf_split_response_state.received_size >= perf_split_response_state.expected_size) {
        perf_split_response_state.response.data.size = perf_split_response_state.expected_size;
        perf_split_response_state.waiting = false;
        perf_split_response_state.complete = true;
        k_sem_give(&perf_split_response_sem);
    }

    k_mutex_unlock(&perf_split_response_mutex);
    return ZMK_EV_EVENT_HANDLED;
}

static int handle_split_perf_request(const zmk_perf_PerfRequest *req, zmk_perf_Response *resp) {
    if (req->response_size > PERF_MAX_DATA_SIZE) {
        return -EMSGSIZE;
    }

    if (req->data.size > UINT16_MAX || req->response_size > UINT16_MAX) {
        return -EMSGSIZE;
    }

    k_mutex_lock(&perf_split_response_mutex, K_FOREVER);
    if (perf_split_response_state.waiting) {
        k_mutex_unlock(&perf_split_response_mutex);
        return -EBUSY;
    }

    k_sem_reset(&perf_split_response_sem);
    perf_split_response_state.waiting = true;
    perf_split_response_state.complete = false;
    perf_split_response_state.sequence_number = req->sequence_number;
    perf_split_response_state.expected_size = 0;
    perf_split_response_state.received_size = 0;
    perf_split_response_state.response = (zmk_perf_PerfResponse)zmk_perf_PerfResponse_init_zero;
    k_mutex_unlock(&perf_split_response_mutex);

    int ret = perf_split_send_request(req);
    if (ret < 0) {
        k_mutex_lock(&perf_split_response_mutex, K_FOREVER);
        perf_split_response_state.waiting = false;
        perf_split_response_state.complete = false;
        k_mutex_unlock(&perf_split_response_mutex);
        return ret;
    }

    ret = k_sem_take(&perf_split_response_sem, K_MSEC(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_TIMEOUT_MS));
    if (ret < 0) {
        k_mutex_lock(&perf_split_response_mutex, K_FOREVER);
        perf_split_response_state.waiting = false;
        perf_split_response_state.complete = false;
        k_mutex_unlock(&perf_split_response_mutex);
        return ret;
    }

    k_mutex_lock(&perf_split_response_mutex, K_FOREVER);
    if (!perf_split_response_state.complete) {
        k_mutex_unlock(&perf_split_response_mutex);
        return -EIO;
    }

    resp->which_response_type = zmk_perf_Response_perf_tag;
    resp->response_type.perf = perf_split_response_state.response;
    perf_split_response_state.complete = false;
    k_mutex_unlock(&perf_split_response_mutex);

    return 0;
}

#else

static struct {
    bool receiving;
    uint32_t sequence_number;
    uint16_t request_size;
    uint16_t response_size;
    uint16_t received_size;
} perf_split_request_state;

static size_t perf_split_response_chunk_max(void) {
    return CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE;
}

static int perf_split_send_response(uint32_t sequence_number, uint16_t response_size) {
    size_t max_chunk_size = perf_split_response_chunk_max();
    uint16_t offset = 0;

    if (response_size > 0 && max_chunk_size == 0) {
        return -EMSGSIZE;
    }

    do {
        size_t remaining = response_size - offset;
        uint8_t chunk_size = MIN(max_chunk_size, remaining);
        struct zmk_perf_split_relay_response event = {
            .source = ZMK_RELAY_EVENT_SOURCE_SELF,
            .sequence_number = sequence_number,
            .response_size = response_size,
            .offset = offset,
            .chunk_size = chunk_size,
        };

        if (chunk_size > 0) {
            memset(event.data, 0xAA, chunk_size);
        }

        int ret = raise_zmk_perf_split_relay_response(event);
        if (ret < 0) {
            return ret;
        }

        if (response_size == 0) {
            break;
        }

        offset += chunk_size;
    } while (offset < response_size);

    return 0;
}

static int perf_split_handle_request_event(const struct zmk_perf_split_relay_request *ev) {
    if (ev->chunk_size > sizeof(ev->data)) {
        LOG_WRN("Malformed split perf request chunk: chunk=%u", ev->chunk_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (ev->response_size > PERF_MAX_DATA_SIZE || ev->offset + ev->chunk_size > ev->request_size) {
        LOG_WRN("Invalid split perf request chunk: seq=%u req=%u resp=%u offset=%u chunk=%u",
                ev->sequence_number, ev->request_size, ev->response_size, ev->offset,
                ev->chunk_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (!perf_split_request_state.receiving ||
        perf_split_request_state.sequence_number != ev->sequence_number || ev->offset == 0) {
        perf_split_request_state.receiving = true;
        perf_split_request_state.sequence_number = ev->sequence_number;
        perf_split_request_state.request_size = ev->request_size;
        perf_split_request_state.response_size = ev->response_size;
        perf_split_request_state.received_size = 0;
    }

    perf_split_request_state.received_size += ev->chunk_size;

    if (perf_split_request_state.received_size >= perf_split_request_state.request_size) {
        perf_split_request_state.receiving = false;
        int ret =
            perf_split_send_response(ev->sequence_number, perf_split_request_state.response_size);
        if (ret < 0) {
            LOG_WRN("Failed to send split perf response: %d", ret);
        }
    }

    return ZMK_EV_EVENT_HANDLED;
}

#endif

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL) && IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)
static int perf_split_relay_response_listener_cb(const zmk_event_t *eh) {
    struct zmk_perf_split_relay_response *ev = as_zmk_perf_split_relay_response(eh);

    return ev ? perf_split_handle_response_event(ev) : ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(perf_split_relay_response, perf_split_relay_response_listener_cb);
ZMK_SUBSCRIPTION(perf_split_relay_response, zmk_perf_split_relay_response);
#else
static int perf_split_relay_request_listener_cb(const zmk_event_t *eh) {
    struct zmk_perf_split_relay_request *ev = as_zmk_perf_split_relay_request(eh);

    return ev ? perf_split_handle_request_event(ev) : ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(perf_split_relay_request, perf_split_relay_request_listener_cb);
ZMK_SUBSCRIPTION(perf_split_relay_request, zmk_perf_split_relay_request);
#endif

#endif

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)

static int handle_perf_request(const zmk_perf_PerfRequest *req, zmk_perf_Response *resp) {
    LOG_DBG("Received perf request: seq=%u response_size=%u request_data_len=%zu split=%d",
            req->sequence_number, req->response_size, req->data.size, req->split);

    if (req->split) {
#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY) &&                                      \
    IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
        return handle_split_perf_request(req, resp);
#else
        return -ENOTSUP;
#endif
    }

    zmk_perf_PerfResponse result = zmk_perf_PerfResponse_init_zero;

    result.sequence_number = req->sequence_number;
    result.split = false;
    result.source = ZMK_RELAY_EVENT_SOURCE_SELF;

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

static struct zmk_rpc_custom_subsystem_meta perf_feature_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("http://localhost:5173"),
    .security = ZMK_STUDIO_RPC_HANDLER_UNSECURED,
};

static bool perf_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                    pb_callback_t *encode_response);

ZMK_RPC_CUSTOM_SUBSYSTEM(zmk__perf, &perf_feature_meta, perf_rpc_handle_request);

ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(zmk__perf, zmk_perf_Response);

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

    int ret = 0;
    switch (req.which_request_type) {
    case zmk_perf_Request_perf_tag:
        ret = handle_perf_request(&req.request_type.perf, resp);
        break;
    default:
        LOG_WRN("Unsupported perf request type: %d", req.which_request_type);
        ret = -ENOTSUP;
    }

    if (ret != 0) {
        zmk_perf_ErrorResponse err = zmk_perf_ErrorResponse_init_zero;
        snprintf(err.message, sizeof(err.message), "Failed to process request: %d", ret);
        resp->which_response_type = zmk_perf_Response_error_tag;
        resp->response_type.error = err;
    }
    return true;
}

#endif
