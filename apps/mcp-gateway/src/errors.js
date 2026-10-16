export class GatewayError extends Error {
  constructor(code, message, details = undefined, status = 400) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function invalidArguments(message, details) {
  return new GatewayError("invalid_arguments", message, details);
}

export function methodNotFound(method) {
  return new GatewayError("method_not_found", `MCP method '${method}' is not supported.`);
}

export function toolNotFound(name) {
  return new GatewayError("tool_not_found", `MCP tool '${name}' is not available.`);
}

export function resourceNotFound(uri) {
  return new GatewayError("resource_not_found", `MCP resource '${uri}' is not available.`);
}
