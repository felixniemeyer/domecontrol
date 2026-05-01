import type { ControllerAlignmentCross, ControllerButtonKey, ControllerCapabilities, ControllerFrame } from './types.js'

export const DOME_CONTROL_PROTOCOL = 'dome-control/v1'

export type ControllerHelloPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-hello'
  sessionId: string
  controllerId: string
  capabilities: Partial<ControllerCapabilities>
  label?: string
}

export type ControllerHeartbeatPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-heartbeat'
  sessionId: string
  controllerId: string
  sentAt: number
}

export type ControllerGoodbyePacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-goodbye'
  sessionId: string
  controllerId: string
  sentAt: number
}

export type ControllerFramePacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-frame'
  sessionId: string
  controllerId: string
  frame: ControllerFrame
}

export type ControllerButtonEventPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-button-event'
  sessionId: string
  controllerId: string
  eventSeq: number
  sentAt: number
  button: ControllerButtonKey
  pressed: boolean
}

export type ControllerButtonAckPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-button-ack'
  sessionId: string
  controllerId: string
  eventSeq: number
}

export type ControllerAlignmentPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-alignment'
  sessionId: string
  controllerId: string
  cross: ControllerAlignmentCross | null
  sentAt: number
}

export type ControllerSignalPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-signal'
  sessionId: string
  fromPeerId: string
  toPeerId: string
  signalType: 'offer' | 'answer' | 'ice-candidate'
  negotiationId?: number
  payload: unknown
}

export type DomeControlPacket =
  | ControllerHelloPacket
  | ControllerHeartbeatPacket
  | ControllerGoodbyePacket
  | ControllerFramePacket
  | ControllerButtonEventPacket
  | ControllerButtonAckPacket
  | ControllerAlignmentPacket
  | ControllerSignalPacket

export function isDomeControlPacket(value: unknown): value is DomeControlPacket {
  if (!value || typeof value !== 'object') return false

  const packet = value as Partial<DomeControlPacket>
  return packet.protocol === DOME_CONTROL_PROTOCOL && typeof packet.type === 'string'
}
