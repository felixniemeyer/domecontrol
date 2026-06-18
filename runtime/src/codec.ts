// Binary wire format for the hot path (controller-input at ~60 Hz). Only the
// input frame is binary — the rare alignment/goodbye packets stay JSON text
// frames (see ws-transport). Keeping the frame fixed-width and tiny (17 B vs
// ~120 B JSON) is the whole point: it is sent continuously per controller.
//
// controller -> relay frame (little-endian):
//   [0..3]  float32 dirX
//   [4..7]  float32 dirY
//   [8..11] float32 dirZ
//   [12]    uint8   flags   (bit0 = accelerate)
//   [13..16]uint32  sequence
//
// The relay prepends a uint16 controller index before forwarding to the host
// (see CONTROLLER_INDEX_BYTES); color / sessionId / controllerId are NOT in the
// hot frame — they are connection-scoped and travel once at join time.

import type { ControllerInputState } from './types.js'

export const INPUT_FRAME_BYTES = 17
export const CONTROLLER_INDEX_BYTES = 2

const FLAG_ACCELERATE = 1

export function encodeControllerInput(input: ControllerInputState): ArrayBuffer {
  const buffer = new ArrayBuffer(INPUT_FRAME_BYTES)
  const view = new DataView(buffer)
  const d = input.direction
  view.setFloat32(0, d[0] ?? 0, true)
  view.setFloat32(4, d[1] ?? 0, true)
  view.setFloat32(8, d[2] ?? 0, true)
  view.setUint8(12, input.accelerate ? FLAG_ACCELERATE : 0)
  view.setUint32(13, (input.sequence ?? 0) >>> 0, true)
  return buffer
}

/** Decode a 17-byte input frame. `view` may be offset into a larger buffer. */
export function decodeControllerInput(view: DataView): ControllerInputState {
  return {
    direction: [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)],
    accelerate: (view.getUint8(12) & FLAG_ACCELERATE) === FLAG_ACCELERATE,
    sequence: view.getUint32(13, true),
  }
}

/** Host-bound frame: [uint16 idx][input frame]. Used to decode on the artwork. */
export function readControllerIndex(data: ArrayBuffer): { idx: number; payload: DataView } {
  return {
    idx: new DataView(data).getUint16(0, true),
    payload: new DataView(data, CONTROLLER_INDEX_BYTES),
  }
}
