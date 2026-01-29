/**
 * CarniTrack Edge Devices Module
 * 
 * Exports for device management, TCP server, and scale parsing.
 */

// TCP Server
export { TCPServer, setGlobalTCPServer, getGlobalTCPServer } from "./tcp-server.ts";
export type { SocketMeta, TCPServerOptions, TCPServerStats } from "./tcp-server.ts";

// Scale Parser
export { 
  ScaleParser, 
  getAckResponse, 
  toParsedScaleEvent,
} from "./scale-parser.ts";
export type { 
  ParsedPacket, 
  ParseResult, 
  ParseError, 
  WeighingEventData,
} from "./scale-parser.ts";

// Device Manager
export {
  DeviceManager,
  getDeviceManager,
  initDeviceManager,
} from "./device-manager.ts";
export type {
  DeviceEvent,
  DeviceEventCallback,
  DeviceRegistrationOptions,
} from "./device-manager.ts";

// Event Processor
export {
  EventProcessor,
  initEventProcessor,
  getEventProcessor,
  destroyEventProcessor,
} from "./event-processor.ts";
