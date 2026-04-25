import { vec2, vec3, type ReadonlyMat3, type ReadonlyVec2, type ReadonlyVec3 } from 'gl-matrix'

const fallbackUp = vec3.fromValues(0, 0, 1)
const fallbackForward = vec3.fromValues(0, 1, 0)
const scratchProjection = vec3.create()
const scratchCam = vec3.create()

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

export function domemasterToCamDir(out: vec3, xy: ReadonlyVec2) {
  const l = Math.hypot(xy[0], xy[1])
  const nx = l > 1e-6 ? xy[0] / l : 0
  const ny = l > 1e-6 ? xy[1] / l : 0
  const angle = l * Math.PI * 0.5
  vec3.set(out, nx * Math.sin(angle), ny * Math.sin(angle), Math.cos(angle))
  return out
}

export function camDirToDomemaster(out: vec2, dir: ReadonlyVec3) {
  const xyLen = Math.hypot(dir[0], dir[1])
  const theta = Math.atan2(xyLen, dir[2])
  const nx = xyLen > 1e-6 ? dir[0] / xyLen : 0
  const ny = xyLen > 1e-6 ? dir[1] / xyLen : 0
  vec2.set(out, nx * theta / (Math.PI * 0.5), ny * theta / (Math.PI * 0.5))
  return out
}

export function worldPosToDomemaster(
  out: vec2,
  worldPos: ReadonlyVec3,
  eyePos: ReadonlyVec3,
  inverseRotation: ReadonlyMat3,
) {
  vec3.sub(scratchCam, worldPos, eyePos)
  vec3.transformMat3(scratchCam, scratchCam, inverseRotation)
  if (vec3.squaredLength(scratchCam) > 1e-12) {
    vec3.normalize(scratchCam, scratchCam)
  }
  return camDirToDomemaster(out, scratchCam)
}

export function orthonormalizeRight(out: vec3, forward: ReadonlyVec3, rightCandidate: ReadonlyVec3) {
  const projection = vec3.dot(forward, rightCandidate)
  vec3.scale(scratchProjection, forward, projection)
  vec3.sub(out, rightCandidate, scratchProjection)
  if (vec3.squaredLength(out) < 1e-8) {
    vec3.cross(out, fallbackUp, forward)
    if (vec3.squaredLength(out) < 1e-8) {
      vec3.cross(out, fallbackForward, forward)
    }
  }
  vec3.normalize(out, out)
  return out
}

export function transformDomemasterDirToWorld(out: vec3, rotation: ReadonlyMat3, dir: ReadonlyVec3) {
  vec3.transformMat3(out, dir, rotation)
  return out
}
