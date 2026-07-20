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
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include <zmk/event_manager.h>

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)
#include <pb_decode.h>
#include <pb_encode.h>
#include <zmk/perf/perf.pb.h>
#include <zmk/studio/custom.h>
#endif

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY) &&                                      \
    !IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
#include <zmk/workqueue.h>
#endif

LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);

#define PERF_MAX_DATA_SIZE 2048

#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY)

/*
 * The structs below are the in-RAM representation of a relayed perf request /
 * response. Only the header plus the *used* payload bytes are put on the wire by
 * the serialize helpers, so a message carrying N payload bytes costs
 * header + N bytes instead of the full CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN that
 * a plain struct memcpy relay would always send.
 *
 * Request wire layout:  [sequence_number: u32 LE][response_size: u16 LE][data...]
 * Response wire layout: [sequence_number: u32 LE][data...]
 *
 * data_size is recovered from the relayed payload length, so it is not on the
 * wire. `source` is managed by the relay framework (set from the transport source
 * on receipt), so it is not serialized either.
 */
#define PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE (sizeof(uint32_t) + sizeof(uint16_t))
#define PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE (sizeof(uint32_t))

#define PERF_SPLIT_RELAY_REQUEST_DATA_SIZE                                                         \
    (CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN - PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE)
#define PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE                                                        \
    (CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN - PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE)

struct zmk_perf_split_relay_request {
    uint8_t source;
    uint32_t sequence_number;
    uint16_t response_size;
    uint16_t data_size;
    uint8_t data[PERF_SPLIT_RELAY_REQUEST_DATA_SIZE];
};

struct zmk_perf_split_relay_response {
    uint8_t source;
    uint32_t sequence_number;
    uint16_t data_size;
    uint8_t data[PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE];
};

BUILD_ASSERT(PERF_SPLIT_RELAY_REQUEST_DATA_SIZE > 0,
             "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN is too small for perf relay requests");
BUILD_ASSERT(PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE > 0,
             "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN is too small for perf relay responses");

ZMK_EVENT_DECLARE(zmk_perf_split_relay_request);
ZMK_EVENT_DECLARE(zmk_perf_split_relay_response);
ZMK_EVENT_IMPL(zmk_perf_split_relay_request);
ZMK_EVENT_IMPL(zmk_perf_split_relay_response);

static int perf_split_relay_request_deserialize(struct zmk_perf_split_relay_request *ev,
                                                const uint8_t *event_data, size_t size) {
    if (size < PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE ||
        size - PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE > sizeof(ev->data)) {
        return -EMSGSIZE;
    }
    ev->sequence_number = sys_get_le32(event_data);
    ev->response_size = sys_get_le16(event_data + sizeof(uint32_t));
    ev->data_size = size - PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE;
    memcpy(ev->data, event_data + PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE, ev->data_size);
    return 0;
}

static int perf_split_relay_response_deserialize(struct zmk_perf_split_relay_response *ev,
                                                 const uint8_t *event_data, size_t size) {
    if (size < PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE ||
        size - PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE > sizeof(ev->data)) {
        return -EMSGSIZE;
    }
    ev->sequence_number = sys_get_le32(event_data);
    ev->data_size = size - PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE;
    memcpy(ev->data, event_data + PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE, ev->data_size);
    return 0;
}

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
static int perf_split_relay_request_serialize(const struct zmk_perf_split_relay_request *ev,
                                              uint8_t *event_data, size_t max_size) {
    if (ev->data_size > PERF_SPLIT_RELAY_REQUEST_DATA_SIZE ||
        PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE + ev->data_size > max_size) {
        return -EMSGSIZE;
    }
    sys_put_le32(ev->sequence_number, event_data);
    sys_put_le16(ev->response_size, event_data + sizeof(uint32_t));
    memcpy(event_data + PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE, ev->data, ev->data_size);
    return PERF_SPLIT_RELAY_REQUEST_HEADER_SIZE + ev->data_size;
}
#else
static int perf_split_relay_response_serialize(const struct zmk_perf_split_relay_response *ev,
                                               uint8_t *event_data, size_t max_size) {
    if (ev->data_size > PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE ||
        PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE + ev->data_size > max_size) {
        return -EMSGSIZE;
    }
    sys_put_le32(ev->sequence_number, event_data);
    memcpy(event_data + PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE, ev->data, ev->data_size);
    return PERF_SPLIT_RELAY_RESPONSE_HEADER_SIZE + ev->data_size;
}
#endif

ZMK_RELAY_EVENT_HANDLE_DESERIALIZE(zmk_perf_split_relay_request, zpr, source,
                                   perf_split_relay_request_deserialize);
ZMK_RELAY_EVENT_HANDLE_DESERIALIZE(zmk_perf_split_relay_response, zps, source,
                                   perf_split_relay_response_deserialize);
ZMK_RELAY_EVENT_CENTRAL_TO_PERIPHERAL_SERIALIZE(zmk_perf_split_relay_request, zpr, source,
                                                perf_split_relay_request_serialize);
ZMK_RELAY_EVENT_PERIPHERAL_TO_CENTRAL_SERIALIZE(zmk_perf_split_relay_response, zps, source,
                                                perf_split_relay_response_serialize);

#if IS_ENABLED(CONFIG_ZMK_SPLIT_ROLE_CENTRAL) && IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER)

static K_MUTEX_DEFINE(perf_split_response_mutex);
static K_SEM_DEFINE(perf_split_response_sem, 0, 1);

static struct {
    bool waiting;
    bool complete;
    uint32_t sequence_number;
    uint8_t source;
    zmk_perf_PerfResponse response;
} perf_split_response_state;

static int perf_split_send_request(const zmk_perf_PerfRequest *req) {
    if (req->data.size > PERF_SPLIT_RELAY_REQUEST_DATA_SIZE ||
        req->response_size > PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE) {
        return -EMSGSIZE;
    }

    struct zmk_perf_split_relay_request event = {
        .source = ZMK_RELAY_EVENT_SOURCE_SELF,
        .sequence_number = req->sequence_number,
        .response_size = req->response_size,
        .data_size = req->data.size,
    };

    memcpy(event.data, req->data.bytes, req->data.size);
    return raise_zmk_perf_split_relay_request(event);
}

static int perf_split_handle_response_event(const struct zmk_perf_split_relay_response *ev) {
    k_mutex_lock(&perf_split_response_mutex, K_FOREVER);

    if (!perf_split_response_state.waiting ||
        perf_split_response_state.sequence_number != ev->sequence_number) {
        k_mutex_unlock(&perf_split_response_mutex);
        return ZMK_EV_EVENT_HANDLED;
    }

    if (ev->data_size > sizeof(ev->data) ||
        ev->data_size > sizeof(perf_split_response_state.response.data.bytes)) {
        LOG_WRN("Invalid split perf response: seq=%u size=%u", ev->sequence_number, ev->data_size);
        k_mutex_unlock(&perf_split_response_mutex);
        return ZMK_EV_EVENT_HANDLED;
    }

    perf_split_response_state.response = (zmk_perf_PerfResponse)zmk_perf_PerfResponse_init_zero;
    perf_split_response_state.response.sequence_number = ev->sequence_number;
    perf_split_response_state.response.split = true;
    perf_split_response_state.response.source = ev->source;
    perf_split_response_state.source = ev->source;
    memcpy(perf_split_response_state.response.data.bytes, ev->data, ev->data_size);
    perf_split_response_state.response.data.size = ev->data_size;
    perf_split_response_state.waiting = false;
    perf_split_response_state.complete = true;
    k_sem_give(&perf_split_response_sem);

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

static int perf_split_send_response(uint32_t sequence_number, uint16_t response_size) {
    if (response_size > PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE) {
        return -EMSGSIZE;
    }

    struct zmk_perf_split_relay_response event = {
        .source = ZMK_RELAY_EVENT_SOURCE_SELF,
        .sequence_number = sequence_number,
        .data_size = response_size,
    };

    memset(event.data, 0xAA, response_size);
    return raise_zmk_perf_split_relay_response(event);
}

/*
 * The incoming request is delivered to us on the system workqueue (the split
 * transport hands relayed events off to it). If we built and raised the response
 * event straight from the request handler, the whole outgoing path -- event
 * raise (which copies the relay struct by value more than once), the
 * peripheral->central serialize listener, and report_event -- would run nested on
 * top of the still-unwound incoming deserialize path on that one workqueue stack.
 * Each hop holds a CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN-sized frame, so the
 * stacked in + out chains overrun the workqueue stack guard and fault the
 * peripheral.
 *
 * Instead, hand the response off to ZMK's low-priority work queue so the request
 * path fully unwinds first and the response is built on a fresh stack; peak stack
 * becomes max(incoming, outgoing) rather than their sum.
 *
 * Note: on a wired half-duplex split the peripheral only transmits its queued
 * events when the central polls, so the response must be enqueued before the next
 * poll. The low-priority queue can lag behind other work; if that regresses the
 * half-duplex round trip, move this back to the system workqueue (k_work_submit).
 */
struct perf_split_pending_response {
    uint32_t sequence_number;
    uint16_t response_size;
};

K_MSGQ_DEFINE(perf_split_pending_response_msgq, sizeof(struct perf_split_pending_response), 4, 4);

/*
 * The outgoing raise -> serialize -> report relay chain keeps several
 * CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN-sized frames live at once (~1KB at the
 * default data length), which is more than the low-priority work queue's default
 * stack. The stack can only be sized from the consumer config, so fail the build
 * with a clear message rather than let the peripheral overflow at runtime. Raise
 * CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE (it scales with the relay data length).
 */
BUILD_ASSERT(CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE >=
                 768 + 4 * CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN,
             "CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE is too small for the perf split relay "
             "response chain; increase it (grows with CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN).");

static void perf_split_send_response_work(struct k_work *work) {
    struct perf_split_pending_response pending;

    while (k_msgq_get(&perf_split_pending_response_msgq, &pending, K_NO_WAIT) == 0) {
        int ret = perf_split_send_response(pending.sequence_number, pending.response_size);
        if (ret < 0) {
            LOG_WRN("Failed to send split perf response: %d", ret);
        }
    }
}

static K_WORK_DEFINE(perf_split_send_response_work_item, perf_split_send_response_work);

static int perf_split_handle_request_event(const struct zmk_perf_split_relay_request *ev) {
    if (ev->data_size > sizeof(ev->data) ||
        ev->response_size > PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE) {
        LOG_WRN("Invalid split perf request: seq=%u req=%u resp=%u", ev->sequence_number,
                ev->data_size, ev->response_size);
        return ZMK_EV_EVENT_HANDLED;
    }

    struct perf_split_pending_response pending = {
        .sequence_number = ev->sequence_number,
        .response_size = ev->response_size,
    };

    if (k_msgq_put(&perf_split_pending_response_msgq, &pending, K_NO_WAIT) != 0) {
        LOG_WRN("Dropping split perf response, queue full: seq=%u", ev->sequence_number);
        return ZMK_EV_EVENT_HANDLED;
    }

    k_work_submit_to_queue(zmk_workqueue_lowprio_work_q(), &perf_split_send_response_work_item);

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

static zmk_perf_Request perf_request_decode_buffer;

static int handle_settings_request(zmk_perf_Response *resp) {
    resp->which_response_type = zmk_perf_Response_settings_tag;
    zmk_perf_SettingsResponse *settings = &resp->response_type.settings;
    *settings = (zmk_perf_SettingsResponse)zmk_perf_SettingsResponse_init_zero;

    settings->studio_rpc_rx_buf_size = CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE;
    settings->studio_rpc_tx_buf_size = CONFIG_ZMK_STUDIO_RPC_TX_BUF_SIZE;
    settings->custom_subsystem_request_payload_max_bytes =
        CONFIG_ZMK_STUDIO_RPC_CUSTOM_SUBSYSTEM_REQUEST_PAYLOAD_MAX_BYTES;
    settings->perf_request_data_max_bytes = PERF_MAX_DATA_SIZE;
    settings->perf_response_data_max_bytes = PERF_MAX_DATA_SIZE;

#if IS_ENABLED(CONFIG_ZMK_SPLIT_RELAY_EVENT)
    settings->split_relay_enabled = true;
    settings->split_relay_event_data_len = CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN;
#if IS_ENABLED(CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY)
    settings->split_relay_request_data_max_bytes = PERF_SPLIT_RELAY_REQUEST_DATA_SIZE;
    settings->split_relay_response_data_max_bytes = PERF_SPLIT_RELAY_RESPONSE_DATA_SIZE;
#endif
#endif

    return 0;
}

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

    resp->which_response_type = zmk_perf_Response_perf_tag;
    zmk_perf_PerfResponse *result = &resp->response_type.perf;
    *result = (zmk_perf_PerfResponse)zmk_perf_PerfResponse_init_zero;

    result->sequence_number = req->sequence_number;
    result->split = false;
    result->source = ZMK_RELAY_EVENT_SOURCE_SELF;

    uint32_t data_size = req->response_size;
    if (data_size > sizeof(result->data.bytes)) {
        data_size = sizeof(result->data.bytes);
    }
    memset(result->data.bytes, 0xAA, data_size);
    result->data.size = data_size;

    return 0;
}

static struct zmk_rpc_custom_subsystem_meta perf_feature_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("https://cormoran.github.io/zmk-feature-studio-rpc-perf/"),
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

    perf_request_decode_buffer = (zmk_perf_Request)zmk_perf_Request_init_zero;

    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);
    if (!pb_decode(&req_stream, zmk_perf_Request_fields, &perf_request_decode_buffer)) {
        LOG_WRN("Failed to decode perf request: %s", PB_GET_ERROR(&req_stream));
        zmk_perf_ErrorResponse err = zmk_perf_ErrorResponse_init_zero;
        snprintf(err.message, sizeof(err.message), "Failed to decode request");
        resp->which_response_type = zmk_perf_Response_error_tag;
        resp->response_type.error = err;
        return true;
    }

    int ret = 0;
    switch (perf_request_decode_buffer.which_request_type) {
    case zmk_perf_Request_perf_tag:
        ret = handle_perf_request(&perf_request_decode_buffer.request_type.perf, resp);
        break;
    case zmk_perf_Request_settings_tag:
        ret = handle_settings_request(resp);
        break;
    default:
        LOG_WRN("Unsupported perf request type: %d", perf_request_decode_buffer.which_request_type);
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
