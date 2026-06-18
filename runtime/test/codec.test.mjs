import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INPUT_FRAME_BYTES,
  CONTROLLER_INDEX_BYTES,
  encodeControllerInput,
  decodeControllerInput,
  readControllerIndex,
} from '../dist/codec.js'

test('controller-input encodes to a fixed 17-byte frame', () => {
  const frame = encodeControllerInput({ direction: [1, 0, 0], accelerate: true, sequence: 5 })
  assert.equal(frame.byteLength, INPUT_FRAME_BYTES)
})

test('controller-input round-trips direction/accelerate/sequence', () => {
  const input = { direction: [0.25, -0.5, 0.75], accelerate: true, sequence: 123456 }
  const decoded = decodeControllerInput(new DataView(encodeControllerInput(input)))
  // float32 precision: compare with tolerance
  assert.ok(Math.abs(decoded.direction[0] - 0.25) < 1e-6)
  assert.ok(Math.abs(decoded.direction[1] - -0.5) < 1e-6)
  assert.ok(Math.abs(decoded.direction[2] - 0.75) < 1e-6)
  assert.equal(decoded.accelerate, true)
  assert.equal(decoded.sequence, 123456)
})

test('accelerate=false decodes false', () => {
  const decoded = decodeControllerInput(new DataView(encodeControllerInput({ direction: [0, 0, 0], accelerate: false })))
  assert.equal(decoded.accelerate, false)
  assert.equal(decoded.sequence, 0)
})

test('readControllerIndex splits idx prefix from an offset payload', () => {
  const payload = encodeControllerInput({ direction: [1, 2, 3], accelerate: true, sequence: 9 })
  // simulate the relay prepending a uint16 idx
  const framed = new Uint8Array(CONTROLLER_INDEX_BYTES + payload.byteLength)
  new DataView(framed.buffer).setUint16(0, 4242, true)
  framed.set(new Uint8Array(payload), CONTROLLER_INDEX_BYTES)

  const { idx, payload: view } = readControllerIndex(framed.buffer)
  assert.equal(idx, 4242)
  const decoded = decodeControllerInput(view)
  assert.equal(decoded.sequence, 9)
  assert.equal(decoded.accelerate, true)
})
