import type { ReadonlyVec3 } from 'gl-matrix'

export type ControllerTransport = 'webrtc' | 'websocket' | 'debug-local' | 'native'

export type ControllerButtons = {
  accelerate: boolean
}

export type ControllerAlignmentCross = 'front' | 'right'

export type ControllerVector3 = [number, number, number]

export type ControllerInputState = {
  direction: ReadonlyVec3 | ControllerVector3
  accelerate: boolean
  color?: string
  sequence?: number
  sentAt?: number
}

export type ControllerPlayerState = {
  id: string
  direction: ControllerVector3
  buttons: ControllerButtons
  color: string
  colorRgb: ControllerVector3
  cursorAlpha: number
  pressAlpha: number
  inactivityAlpha: number
  lastHeartbeatAt: number
  lastInputAt: number
}

export type ControllerSessionState = {
  sessionId: string
  transport: ControllerTransport
  players: ControllerPlayerState[]
  updatedAt: number
}
