export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isOpenVikingEnvelope(value) {
    // A wrapped response carries `result` or `error` alongside `status`; the
    // unauthenticated `/health` endpoint returns a raw object whose `status`
    // field must not be mistaken for an envelope.
    return (isRecord(value) &&
        typeof value.status === "string" &&
        ("result" in value || "error" in value));
}
export function isTempUploadResult(value) {
    return isRecord(value) && typeof value.temp_file_id === "string";
}
/**
 * The normalized OpenViking error this plugin surfaces to tools and logs.
 * `code`/`message` come from the service wrapper; `status` is the HTTP status.
 * Never carries the API key.
 */
export class OpenVikingError extends Error {
    code;
    httpStatus;
    endpoint;
    constructor(endpoint, message, options) {
        const suffix = options?.code ? ` [${options.code}]` : "";
        super(`${endpoint}: ${message}${suffix}`);
        this.name = "OpenVikingError";
        this.endpoint = endpoint;
        this.code = options?.code;
        this.httpStatus = options?.httpStatus;
    }
}
/** A request that exceeded the configured timeout (or an explicit wait timeout). */
export class OpenVikingTimeoutError extends OpenVikingError {
    constructor(endpoint) {
        super(endpoint, "request timed out");
        this.name = "OpenVikingTimeoutError";
    }
}
