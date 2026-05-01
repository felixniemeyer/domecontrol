import type { ReadonlyVec3 } from 'gl-matrix'

export type ControllerTransport = 'webrtc' | 'websocket' | 'debug-local' | 'native'

export type ControllerButtons = {
  accelerate: boolean
}

export type ControllerButtonKey = keyof ControllerButtons
export type ControllerAlignmentCross = 'front' | 'right'

export type ControllerVector3 = [number, number, number]

export type ControllerCapabilities = {
  orientation: boolean
  touch: boolean
  haptics: boolean
  gamepad: boolean
}

export type ControllerFrame = {
  direction: ReadonlyVec3 | ControllerVector3
  buttons: ControllerButtons
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
