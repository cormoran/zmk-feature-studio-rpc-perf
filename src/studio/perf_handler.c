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

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT)
#include <zmk/split/transport/types.h>

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
#include <zmk/split/central.h>
#elif !IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
#include <zmk/split/peripheral.h>
#endif
#endif

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#define PERF_SPLIT_REQUEST_EVENT "zprq"
#define PERF_SPLIT_RESPONSE_EVENT "zprs"
#define PERF_MAX_DATA_SIZE 2048

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT)

struct zmk_perf_split_request_chunk_header {
    uint32_t sequence_number;
    uint16_t request_size;
    uint16_t response_size;
    uint16_t offset;
    uint8_t chunk_size;
} __packed;

struct zmk_perf_split_response_chunk_header {
    uint32_t sequence_number;
    uint16_t response_size;
    uint16_t offset;
    uint8_t chunk_size;
} __packed;

static bool perf_relay_event_matches(const struct zmk_relay_event_received *ev,
                                     const char *event_name) {
    return ev != NULL && strcmp(ev->event_name, event_name) == 0;
}

static int perf_split_payload_init(struct zmk_split_relay_event_payload *payload,
                                   const char *event_name, const void *header, size_t header_size,
                                   const uint8_t *chunk, size_t chunk_size) {
    size_t event_name_len = strlen(event_name);
    size_t event_data_size = header_size + chunk_size;

    if (event_name_len > CONFIG_ZMK_SPLIT_RELAY_EVENT_TYPE_NAME_LEN) {
        return -ENAMETOOLONG;
    }

    if (event_data_size > CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN || event_data_size > UINT8_MAX) {
        return -EMSGSIZE;
    }

    memset(payload, 0, sizeof(*payload));
    payload->header.event_type_size = event_name_len;
    payload->header.event_data_size = event_data_size;
    memcpy(payload->event_type, event_name, event_name_len);
    memcpy(payload->event_data, header, header_size);
    if (chunk_size > 0) {
        memcpy(payload->event_data + header_size, chunk, chunk_size);
    }

    return 0;
}

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
    size_t max_event_data_size = MIN(CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN, UINT8_MAX);

    if (max_event_data_size <= sizeof(struct zmk_perf_split_request_chunk_header)) {
        return 0;
    }

    return max_event_data_size - sizeof(struct zmk_perf_split_request_chunk_header);
}

static int perf_split_send_central_payload(struct zmk_split_relay_event_payload *payload) {
    int ret = 0;
    int64_t deadline = k_uptime_get() + CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_TIMEOUT_MS;

    do {
        ret = zmk_split_central_send_relay_event(payload);
        if (ret == 0) {
            return 0;
        }

        k_sleep(K_MSEC(1));
    } while (k_uptime_get() < deadline);

    return ret;
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
        struct zmk_perf_split_request_chunk_header header = {
            .sequence_number = req->sequence_number,
            .request_size = request_size,
            .response_size = req->response_size,
            .offset = offset,
            .chunk_size = chunk_size,
        };
        struct zmk_split_relay_event_payload payload;

        int ret = perf_split_payload_init(&payload, PERF_SPLIT_REQUEST_EVENT, &header,
                                          sizeof(header), req->data.bytes + offset, chunk_size);
        if (ret < 0) {
            return ret;
        }

        ret = perf_split_send_central_payload(&payload);
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

static int perf_split_handle_response_event(const struct zmk_relay_event_received *ev) {
    if (ev->event_data_size < sizeof(struct zmk_perf_split_response_chunk_header)) {
        LOG_WRN("Split perf response chunk too small: %zu", ev->event_data_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    struct zmk_perf_split_response_chunk_header header;
    memcpy(&header, ev->event_data, sizeof(header));

    if (ev->event_data_size != sizeof(header) + header.chunk_size) {
        LOG_WRN("Malformed split perf response chunk: expected %zu, got %zu",
                sizeof(header) + header.chunk_size, ev->event_data_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    k_mutex_lock(&perf_split_response_mutex, K_FOREVER);

    if (!perf_split_response_state.waiting ||
        perf_split_response_state.sequence_number != header.sequence_number) {
        k_mutex_unlock(&perf_split_response_mutex);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (header.response_size > sizeof(perf_split_response_state.response.data.bytes) ||
        header.offset + header.chunk_size > header.response_size) {
        LOG_WRN("Invalid split perf response chunk: seq=%u size=%u offset=%u chunk=%u",
                header.sequence_number, header.response_size, header.offset, header.chunk_size);
        k_mutex_unlock(&perf_split_response_mutex);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (header.offset == 0) {
        perf_split_response_state.expected_size = header.response_size;
        perf_split_response_state.received_size = 0;
        perf_split_response_state.response = (zmk_perf_PerfResponse)zmk_perf_PerfResponse_init_zero;
        perf_split_response_state.response.sequence_number = header.sequence_number;
        perf_split_response_state.response.split = true;
        perf_split_response_state.response.source = ev->source;
        perf_split_response_state.source = ev->source;
    }

    if (header.chunk_size > 0) {
        memcpy(perf_split_response_state.response.data.bytes + header.offset,
               ev->event_data + sizeof(header), header.chunk_size);
    }
    perf_split_response_state.received_size += header.chunk_size;

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
    size_t max_event_data_size = MIN(CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN, UINT8_MAX);

    if (max_event_data_size <= sizeof(struct zmk_perf_split_response_chunk_header)) {
        return 0;
    }

    return max_event_data_size - sizeof(struct zmk_perf_split_response_chunk_header);
}

static int perf_split_send_peripheral_payload(struct zmk_split_relay_event_payload *payload) {
    int ret = 0;
    int64_t deadline = k_uptime_get() + CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_TIMEOUT_MS;

    do {
        struct zmk_split_transport_peripheral_event event = {
            .type = ZMK_SPLIT_TRANSPORT_PERIPHERAL_EVENT_TYPE_RELAY_EVENT,
            .data = {.relay_event = {.header = payload->header}},
        };

        memcpy(event.data.relay_event.event_type, payload->event_type,
               payload->header.event_type_size);
        event.data.relay_event.event_type[payload->header.event_type_size] = '\0';
        memcpy(event.data.relay_event.event_data, payload->event_data,
               payload->header.event_data_size);

        ret = zmk_split_peripheral_report_event(&event);
        if (ret == 0) {
            return 0;
        }

        k_sleep(K_MSEC(1));
    } while (k_uptime_get() < deadline);

    return ret;
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
        struct zmk_perf_split_response_chunk_header header = {
            .sequence_number = sequence_number,
            .response_size = response_size,
            .offset = offset,
            .chunk_size = chunk_size,
        };
        struct zmk_split_relay_event_payload payload;

        int ret = perf_split_payload_init(&payload, PERF_SPLIT_RESPONSE_EVENT, &header,
                                          sizeof(header), NULL, 0);
        if (ret < 0) {
            return ret;
        }

        if (chunk_size > 0) {
            memset(payload.event_data + sizeof(header), 0xAA, chunk_size);
            payload.header.event_data_size = sizeof(header) + chunk_size;
        }

        ret = perf_split_send_peripheral_payload(&payload);
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

static int perf_split_handle_request_event(const struct zmk_relay_event_received *ev) {
    if (ev->event_data_size < sizeof(struct zmk_perf_split_request_chunk_header)) {
        LOG_WRN("Split perf request chunk too small: %zu", ev->event_data_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    struct zmk_perf_split_request_chunk_header header;
    memcpy(&header, ev->event_data, sizeof(header));

    if (ev->event_data_size != sizeof(header) + header.chunk_size) {
        LOG_WRN("Malformed split perf request chunk: expected %zu, got %zu",
                sizeof(header) + header.chunk_size, ev->event_data_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (header.response_size > PERF_MAX_DATA_SIZE ||
        header.offset + header.chunk_size > header.request_size) {
        LOG_WRN("Invalid split perf request chunk: seq=%u req=%u resp=%u offset=%u chunk=%u",
                header.sequence_number, header.request_size, header.response_size, header.offset,
                header.chunk_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (!perf_split_request_state.receiving ||
        perf_split_request_state.sequence_number != header.sequence_number || header.offset == 0) {
        perf_split_request_state.receiving = true;
        perf_split_request_state.sequence_number = header.sequence_number;
        perf_split_request_state.request_size = header.request_size;
        perf_split_request_state.response_size = header.response_size;
        perf_split_request_state.received_size = 0;
    }

    perf_split_request_state.received_size += header.chunk_size;

    if (perf_split_request_state.received_size >= perf_split_request_state.request_size) {
        perf_split_request_state.receiving = false;
        int ret = perf_split_send_response(header.sequence_number,
                                           perf_split_request_state.response_size);
        if (ret < 0) {
            LOG_WRN("Failed to send split perf response: %d", ret);
        }
    }

    return ZMK_EV_EVENT_HANDLED;
}

#endif

static int perf_split_relay_listener_cb(const zmk_event_t *eh) {
    struct zmk_relay_event_received *ev = as_zmk_relay_event_received(eh);

    if (perf_relay_event_matches(ev, PERF_SPLIT_RESPONSE_EVENT)) {
#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL) && IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)
        return perf_split_handle_response_event(ev);
#else
        return ZMK_EV_EVENT_BUBBLE;
#endif
    }

    if (perf_relay_event_matches(ev, PERF_SPLIT_REQUEST_EVENT)) {
#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
        return ZMK_EV_EVENT_BUBBLE;
#else
        return perf_split_handle_request_event(ev);
#endif
    }

    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(perf_split_relay, perf_split_relay_listener_cb);
ZMK_SUBSCRIPTION(perf_split_relay, zmk_relay_event_received);

#endif

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)

static int handle_perf_request(const zmk_perf_PerfRequest *req, zmk_perf_Response *resp) {
    LOG_DBG("Received perf request: seq=%u response_size=%u request_data_len=%zu split=%d",
            req->sequence_number, req->response_size, req->data.size, req->split);

    if (req->split) {
#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT) && IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
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
