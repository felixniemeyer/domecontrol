import type { ControllerAlignmentCross, ControllerInputState } from './types.js'

export const DOME_CONTROL_PROTOCOL = 'dome-control/v1'

export type ControllerGoodbyePacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-goodbye'
  sessionId: string
  controllerId: string
  sentAt: number
}

export type ControllerInputPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-input'
  sessionId: string
  controllerId: string
  input: ControllerInputState
}

export type ControllerAlignmentPacket = {
  protocol: typeof DOME_CONTROL_PROTOCOL
  type: 'controller-alignment'
  sessionId: string
  controllerId: string
  cross: ControllerAlignmentCross | null
  sentAt: number
}

export type DomeControlPacket =
  | ControllerGoodbyePacket
  | ControllerInputPacket
  | ControllerAlignmentPacket
