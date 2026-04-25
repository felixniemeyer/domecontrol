import './style.css'

import { mat3, vec2, vec3 } from 'gl-matrix'
import { DataConnection, Peer } from 'peerjs'
import {
  DOME_CONTROL_PROTOCOL,
  camDirToDomemaster,
  domemasterToCamDir,
  isDomeControlPacket,
  type ControllerButtonAckPacket,
  type ControllerButtons,
  type ControllerButtonEventPacket,
  type ControllerButtonKey,
  type ControllerFrame,
  type ControllerFramePacket,
  type ControllerGoodbyePacket,
  type ControllerHeartbeatPacket,
  type ControllerHelloPacket,
} from '../../Runtime/src/index'

type ArtworkRuntimeTarget = {
  upsertControllerFrame?: (id: string, frame: ControllerFrame, transport?: 'debug-local') => void
  removeController?: (id: string) => void
}

type CalibrationPhase = 'front' | 'right' | 'done'

type CalibrationSample = {
  forward: vec3
  right: vec3
}

type AbsoluteOrientationSensorOptions = {
  frequency?: number
  referenceFrame?: 'device' | 'screen'
}

type AbsoluteOrientationSensorInstance = EventTarget & {
  quaternion: readonly number[] | Float32Array | Float64Array | null
  start: () => void
  stop: () => void
}

type AbsoluteOrientationSensorConstructor = new (
  options?: AbsoluteOrientationSensorOptions,
) => AbsoluteOrientationSensorInstance

const buttonSpecs: Array<{ key: keyof ControllerButtons; label: string }> = [
  { key: 'accelerate', label: 'Accelerate' },
]

const query = new URLSearchParams(window.location.search)
const laptopMode = query.get('laptop') === '1'
const webrtcLogEnabled = query.get('webrtc-log') === '1'
const sessionId = query.get('session') ?? 'fabric-artwork-local'
const controllerId = query.get('controller') ?? `controller-${Math.random().toString(36).slice(2, 8)}`
const artworkPeerId = query.get('artwork-peer') ?? 'artwork-runtime'
const peerHost = query.get('peer-host') ?? window.location.hostname ?? '127.0.0.1'
const peerSecure = query.get('peer-secure') === '1' || (
  query.get('peer-secure') !== '0' && window.location.protocol === 'https:'
)
const peerPort = Number(query.get('peer-port') ?? (peerSecure ? window.location.port || 443 : 8081))
const peerPath = query.get('peer-path') ?? '/peerjs'
const peerConfig = buildPeerConfig(query)

const direction = vec3.fromValues(0, 0, 1)
const domemasterCursor = vec2.create()
const buttons: ControllerButtons = {
  accelerate: false,
}

const localDeviceForward = vec3.fromValues(0, 0, -1)
const localDeviceRight = vec3.fromValues(1, 0, 0)
const rawForward = vec3.create()
const rawRight = vec3.create()
const calibratedForward = vec3.create()
const basisFront = vec3.create()
const basisRight = vec3.create()
const basisUp = vec3.create()
const scratchVec = vec3.create()
const scratchVecB = vec3.create()
const scratchOrientation = mat3.create()

const calibrationSamples: Record<'front' | 'right', CalibrationSample | null> = {
  front: null,
  right: null,
}

let calibrationPhase: CalibrationPhase = 'front'
let hasSensorSample = false
let motionAttached = false
let orientationSensor: AbsoluteOrientationSensorInstance | null = null
let frameSequence = 0
let buttonEventSequence = 0
let peer: Peer | null = null
let controlConnection: DataConnection | null = null
let cameraStream: MediaStream | null = null
let transportLabel = 'Disconnected'
let inputLabel = 'Pointer aiming active'
let lastSentSignature = ''
let peerReconnectTimer: number | null = null
const pendingButtonEvents = new Map<number, ControllerButtonEventPacket>()
let buttonRetryTimer: number | null = null
const buttonRetryIntervalMs = 80

function getQueryList(params: URLSearchParams, ...names: string[]) {
  return names.flatMap((name) =>
    params.getAll(name).flatMap((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  )
}

function buildPeerConfig(params: URLSearchParams): RTCConfiguration {
  const iceServers: RTCIceServer[] = []
  const genericIceUrls = getQueryList(params, 'ice-server', 'ice-url')
  const stunUrls = getQueryList(params, 'stun', 'stun-url')
  const turnUrls = getQueryList(params, 'turn', 'turn-url')
  const turnUsername = params.get('turn-username') ?? undefined
  const turnCredential = params.get('turn-credential') ?? undefined

  if (genericIceUrls.length > 0) {
    iceServers.push({
      urls: genericIceUrls,
      username: turnUsername,
      credential: turnCredential,
    })
  }

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls })
  }

  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    })
  }

  if (iceServers.length === 0) {
    iceServers.push({ urls: 'stun:stun.l.google.com:19302' })
  }

  const requestedPolicy = params.get('ice-transport-policy') ?? params.get('ice-policy')
  const iceTransportPolicy = requestedPolicy === 'relay' || requestedPolicy === 'all'
    ? requestedPolicy
    : undefined

  return {
    iceServers,
    iceTransportPolicy,
  }
}

function summarizePeerConfig(config: RTCConfiguration) {
  return {
    iceTransportPolicy: config.iceTransportPolicy ?? 'all',
    iceServers: config.iceServers?.map((server) => ({
      urls: server.urls,
      hasUsername: Boolean(server.username),
      hasCredential: Boolean(server.credential),
    })) ?? [],
  }
}

function logWebRtc(event: string, data?: Record<string, unknown>) {
  if (!webrtcLogEnabled) return
  console.info(`[dome-control/client] ${event}`, {
    controllerId,
    sessionId,
    ...data,
  })
}

const introScreen = document.getElementById('intro-screen') as HTMLElement
const introTitle = introScreen.querySelector('h1') as HTMLHeadingElement
const calibrationScreen = document.getElementById('calibration-screen') as HTMLElement
const controlScreen = document.getElementById('control-screen') as HTMLElement
const calibrationPreview = document.getElementById('calibration-preview') as HTMLDivElement
const calibrationHeading = document.getElementById('calibration-heading') as HTMLParagraphElement
const aimPad = document.getElementById('aim-pad') as HTMLDivElement
const aimCursor = document.getElementById('aim-cursor') as HTMLDivElement
const buttonGrid = document.getElementById('button-grid') as HTMLDivElement
const laptopJoystickPanel = document.getElementById('laptop-joystick-panel') as HTMLElement
const transportStatus = document.getElementById('transport-status') as HTMLParagraphElement
const inputStatus = document.getElementById('input-status') as HTMLParagraphElement
const controlCopy = document.getElementById('control-copy') as HTMLParagraphElement
const controlTitle = document.getElementById('control-title') as HTMLHeadingElement
const controlEyebrow = document.getElementById('control-eyebrow') as HTMLParagraphElement
const controllerState = document.getElementById('controller-state') as HTMLPreElement
const lastPacket = document.getElementById('last-packet') as HTMLPreElement
const calibrationCamera = document.getElementById('calibration-camera') as HTMLVideoElement
const startCalibrationButton = document.getElementById('start-calibration') as HTMLButtonElement
const backCalibrationButton = document.getElementById('back-calibration') as HTMLButtonElement
const confirmAlignmentButton = document.getElementById('confirm-alignment') as HTMLButtonElement

function setTransportStatus(label: string) {
  transportLabel = label
  transportStatus.textContent = `${label} · ${controllerId}`
}

function setInputStatus(label: string) {
  inputLabel = label
  inputStatus.textContent = label
}

function setUnsupportedOrientationUi() {
  setActiveScreen('intro')
  introTitle.textContent = "Your browser or phone does not support absolute orientation measuring. We're sorry."
  startCalibrationButton.hidden = true
  setInputStatus('Absolute orientation unavailable')
}

function setActiveScreen(screen: 'intro' | 'calibration' | 'control') {
  introScreen.hidden = screen !== 'intro'
  calibrationScreen.hidden = screen !== 'calibration'
  controlScreen.hidden = screen !== 'control'
}

function setCalibrationUi() {
  if (laptopMode) {
    setActiveScreen('control')
    controlScreen.dataset.mode = 'laptop'
    laptopJoystickPanel.hidden = false
    controlEyebrow.textContent = 'dome-control'
    controlTitle.textContent = 'Laptop controls'
    controlCopy.textContent = 'Laptop mode: drag the joystick to aim and hold accelerate.'
    return
  }

  setActiveScreen(calibrationPhase === 'done' ? 'control' : 'calibration')
  controlScreen.dataset.mode = 'phone'
  laptopJoystickPanel.hidden = true
  controlEyebrow.textContent = 'dome-control'
  controlTitle.textContent = 'Phone controls'
  controlCopy.textContent = 'Use phone orientation and hold accelerate.'
  calibrationPreview.hidden = false
  confirmAlignmentButton.hidden = calibrationPhase === 'done'
  backCalibrationButton.hidden = calibrationPhase === 'done'

  if (calibrationPhase === 'front') {
    calibrationScreen.dataset.phase = 'front'
    calibrationHeading.textContent = 'front'
    confirmAlignmentButton.textContent = 'Confirm'
    confirmAlignmentButton.disabled = !hasSensorSample
    backCalibrationButton.textContent = 'Back'
    return
  }

  if (calibrationPhase === 'right') {
    calibrationScreen.dataset.phase = 'right'
    calibrationHeading.textContent = 'right'
    confirmAlignmentButton.textContent = 'Confirm'
    confirmAlignmentButton.disabled = !hasSensorSample
    backCalibrationButton.textContent = 'Back'
    return
  }

  confirmAlignmentButton.hidden = true
  backCalibrationButton.hidden = true
  calibrationPreview.hidden = true
  confirmAlignmentButton.disabled = false
}

function buildFrame(): ControllerFrame {
  return {
    direction: [direction[0], direction[1], direction[2]],
    buttons: { ...buttons },
    sequence: frameSequence,
    sentAt: performance.now() * 0.001,
    color: '#8bd3ff',
  }
}

function buildFramePacket(frame: ControllerFrame): ControllerFramePacket {
  return {
    protocol: DOME_CONTROL_PROTOCOL,
    type: 'controller-frame',
    sessionId,
    controllerId,
    frame,
  }
}

function buildHeartbeatPacket(): ControllerHeartbeatPacket {
  return {
    protocol: DOME_CONTROL_PROTOCOL,
    type: 'controller-heartbeat',
    sessionId,
    controllerId,
    sentAt: performance.now() * 0.001,
  }
}

function buildButtonEventPacket(button: ControllerButtonKey, pressed: boolean): ControllerButtonEventPacket {
  buttonEventSequence += 1
  return {
    protocol: DOME_CONTROL_PROTOCOL,
    type: 'controller-button-event',
    sessionId,
    controllerId,
    eventSeq: buttonEventSequence,
    sentAt: performance.now() * 0.001,
    button,
    pressed,
  }
}

function isAckForThisController(packet: ControllerButtonAckPacket) {
  return packet.sessionId === sessionId && packet.controllerId === controllerId
}

function buildGoodbyePacket(): ControllerGoodbyePacket {
  return {
    protocol: DOME_CONTROL_PROTOCOL,
    type: 'controller-goodbye',
    sessionId,
    controllerId,
    sentAt: performance.now() * 0.001,
  }
}

function buildHelloPacket(): ControllerHelloPacket {
  return {
    protocol: DOME_CONTROL_PROTOCOL,
    type: 'controller-hello',
    sessionId,
    controllerId,
    label: 'dome-control-client',
    capabilities: {
      orientation: !laptopMode && isAbsoluteOrientationSupported(),
      touch: true,
      haptics: false,
      gamepad: laptopMode,
    },
  }
}

function findArtworkTarget(): ArtworkRuntimeTarget | null {
  try {
    if (window.opener && !window.opener.closed && 'domeControlRuntime' in window.opener) {
      return window.opener.domeControlRuntime as ArtworkRuntimeTarget
    }
  } catch {
    // Ignore cross-window access failures.
  }

  try {
    if (window.parent !== window && 'domeControlRuntime' in window.parent) {
      return window.parent.domeControlRuntime as ArtworkRuntimeTarget
    }
  } catch {
    // Ignore cross-frame access failures.
  }

  return null
}

function updateDiagnostics(frame: ControllerFrame, packet: ControllerFramePacket) {
  if (controllerState) {
    controllerState.textContent = JSON.stringify(
      {
        sessionId,
        controllerId,
        direction: frame.direction,
        buttons: frame.buttons,
        transport: transportLabel,
        input: inputLabel,
        calibrationPhase,
      },
      null,
      2,
    )
  }
  if (lastPacket) {
    lastPacket.textContent = JSON.stringify(packet, null, 2)
  }
}

function sendFrame() {
  const frame = buildFrame()
  const packet = buildFramePacket(frame)

  const directTarget = findArtworkTarget()
  if (directTarget?.upsertControllerFrame) {
    directTarget.upsertControllerFrame(controllerId, frame, 'debug-local')
    setTransportStatus('Connected via opener/parent')
  } else if (controlConnection?.open) {
    controlConnection.send(packet)
    setTransportStatus(`Connected via PeerJS ${peerHost}:${peerPort}`)
  } else {
    setTransportStatus('Disconnected')
  }

  updateDiagnostics(frame, packet)
}

function sendHeartbeat() {
  const packet = buildHeartbeatPacket()
  const directTarget = findArtworkTarget()
  if (directTarget?.upsertControllerFrame) {
    return
  }
  if (controlConnection?.open) {
    controlConnection.send(packet)
  }
}

function sendButtonEvent(button: ControllerButtonKey, pressed: boolean) {
  const packet = buildButtonEventPacket(button, pressed)
  const directTarget = findArtworkTarget()
  if (directTarget?.upsertControllerFrame) {
    if (lastPacket) {
      lastPacket.textContent = JSON.stringify(packet, null, 2)
    }
    return
  }

  pendingButtonEvents.set(packet.eventSeq, packet)
  startButtonRetryTimer()
  sendPendingButtonEvent(packet)
}

function sendPendingButtonEvent(packet: ControllerButtonEventPacket) {
  if (controlConnection?.open && pendingButtonEvents.has(packet.eventSeq)) {
    controlConnection.send(packet)
    if (lastPacket) {
      lastPacket.textContent = JSON.stringify(packet, null, 2)
    }
  }
}

function startButtonRetryTimer() {
  if (buttonRetryTimer != null) return
  buttonRetryTimer = window.setInterval(() => {
    if (pendingButtonEvents.size === 0) {
      stopButtonRetryTimer()
      return
    }
    for (const packet of pendingButtonEvents.values()) {
      sendPendingButtonEvent(packet)
    }
  }, buttonRetryIntervalMs)
}

function stopButtonRetryTimer() {
  if (buttonRetryTimer == null) return
  window.clearInterval(buttonRetryTimer)
  buttonRetryTimer = null
}

function handleButtonAck(packet: ControllerButtonAckPacket) {
  if (!isAckForThisController(packet)) return
  pendingButtonEvents.delete(packet.eventSeq)
  if (pendingButtonEvents.size === 0) {
    stopButtonRetryTimer()
  }
}

function queueFrameIfChanged(force = false) {
  const signature = JSON.stringify({
    direction: [direction[0], direction[1], direction[2]],
    buttons,
  })
  if (!force && signature === lastSentSignature) return
  lastSentSignature = signature
  frameSequence += 1
  sendFrame()
}

function syncCursorFromDirection() {
  camDirToDomemaster(domemasterCursor, direction)
  aimCursor.style.left = `${(domemasterCursor[0] + 1) * 50}%`
  aimCursor.style.top = `${(domemasterCursor[1] + 1) * 50}%`
}

function applyControllerDirection(nextDirection: vec3, modeLabel: string) {
  vec3.copy(direction, nextDirection)
  if (vec3.squaredLength(direction) < 1e-8) {
    vec3.set(direction, 0, 0, 1)
  } else {
    vec3.normalize(direction, direction)
  }

  syncCursorFromDirection()
  setInputStatus(modeLabel)
  queueFrameIfChanged()
}

function updateAimFromPointer(x: number, y: number) {
  const rect = aimPad.getBoundingClientRect()
  const nx = (x - rect.left) / rect.width * 2 - 1
  const ny = (y - rect.top) / rect.height * 2 - 1
  const length = Math.hypot(nx, ny)
  const cx = length > 1 ? nx / length : nx
  const cy = length > 1 ? ny / length : ny

  domemasterToCamDir(direction, [cx, cy])
  syncCursorFromDirection()
  setInputStatus(laptopMode ? 'Laptop joystick active' : 'Pointer aiming active')
  queueFrameIfChanged()
}

function currentScreenAngleRadians() {
  if (typeof screen.orientation?.angle === 'number') {
    return screen.orientation.angle * Math.PI / 180
  }
  const legacyOrientation = (window as Window & { orientation?: number }).orientation
  if (typeof legacyOrientation === 'number') {
    return legacyOrientation * Math.PI / 180
  }
  return 0
}

function projectVectorIntoCalibration(out: vec3, vector: vec3) {
  vec3.set(
    out,
    vec3.dot(vector, basisRight),
    vec3.dot(vector, basisUp),
    vec3.dot(vector, basisFront),
  )
  if (vec3.squaredLength(out) < 1e-8) {
    vec3.set(out, 0, 0, 1)
  } else {
    vec3.normalize(out, out)
  }
}

function tryBuildCalibrationBasis() {
  const frontSample = calibrationSamples.front
  const rightSample = calibrationSamples.right
  if (!frontSample || !rightSample) return false

  vec3.copy(basisFront, frontSample.forward)
  vec3.scale(scratchVec, basisFront, vec3.dot(rightSample.forward, basisFront))
  vec3.sub(scratchVecB, rightSample.forward, scratchVec)

  if (vec3.squaredLength(scratchVecB) < 1e-8) {
    vec3.scale(scratchVec, basisFront, vec3.dot(frontSample.right, basisFront))
    vec3.sub(scratchVecB, frontSample.right, scratchVec)
  }
  if (vec3.squaredLength(scratchVecB) < 1e-8) {
    return false
  }

  vec3.normalize(basisRight, scratchVecB)
  vec3.cross(basisUp, basisFront, basisRight)
  if (vec3.squaredLength(basisUp) < 1e-8) {
    return false
  }
  vec3.normalize(basisUp, basisUp)
  vec3.cross(basisRight, basisUp, basisFront)
  vec3.normalize(basisRight, basisRight)
  return true
}

function captureCurrentSample(): CalibrationSample | null {
  if (!hasSensorSample) return null
  return {
    forward: vec3.clone(rawForward),
    right: vec3.clone(rawRight),
  }
}

function resetCalibration() {
  if (laptopMode) {
    return
  }
  calibrationSamples.front = null
  calibrationSamples.right = null
  vec3.zero(basisFront)
  vec3.zero(basisRight)
  vec3.zero(basisUp)
  calibrationPhase = 'front'
  setInputStatus('Awaiting phone calibration')
  setCalibrationUi()
}

function confirmCalibrationStep() {
  if (laptopMode) {
    return
  }
  const sample = captureCurrentSample()
  if (!sample) return

  if (calibrationPhase === 'front') {
    calibrationSamples.front = sample
    calibrationPhase = 'right'
    setCalibrationUi()
    return
  }

  if (calibrationPhase === 'right') {
    calibrationSamples.right = sample
    if (!tryBuildCalibrationBasis()) return
    projectVectorIntoCalibration(calibratedForward, rawForward)
    applyControllerDirection(calibratedForward, 'Motion aiming active')
    calibrationPhase = 'done'
    setCalibrationUi()
    return
  }

  resetCalibration()
}

function getAbsoluteOrientationSensorConstructor() {
  return (window as Window & {
    AbsoluteOrientationSensor?: AbsoluteOrientationSensorConstructor
  }).AbsoluteOrientationSensor
}

function isAbsoluteOrientationSupported() {
  return typeof getAbsoluteOrientationSensorConstructor() === 'function'
}

function onAbsoluteOrientationReading() {
  if (!orientationSensor?.quaternion || orientationSensor.quaternion.length < 4) {
    return
  }

  mat3.fromQuat(scratchOrientation, [
    orientationSensor.quaternion[0],
    orientationSensor.quaternion[1],
    orientationSensor.quaternion[2],
    orientationSensor.quaternion[3],
  ])
  mat3.rotate(scratchOrientation, scratchOrientation, -currentScreenAngleRadians())
  vec3.transformMat3(rawForward, localDeviceForward, scratchOrientation)
  vec3.transformMat3(rawRight, localDeviceRight, scratchOrientation)
  vec3.normalize(rawForward, rawForward)
  vec3.normalize(rawRight, rawRight)
  hasSensorSample = true

  if (calibrationPhase === 'done') {
    projectVectorIntoCalibration(calibratedForward, rawForward)
    applyControllerDirection(calibratedForward, 'Motion aiming active')
  } else {
    setInputStatus('Motion sample ready for calibration')
  }

  setCalibrationUi()
}

async function enableMotion() {
  if (laptopMode) {
    return true
  }
  const AbsoluteOrientationSensorCtor = getAbsoluteOrientationSensorConstructor()
  if (!AbsoluteOrientationSensorCtor) {
    setUnsupportedOrientationUi()
    return false
  }

  if (!motionAttached) {
    try {
      orientationSensor = new AbsoluteOrientationSensorCtor({
        frequency: 60,
        referenceFrame: 'device',
      })
      orientationSensor.addEventListener('reading', onAbsoluteOrientationReading)
      orientationSensor.addEventListener('error', () => {
        setUnsupportedOrientationUi()
      })
      orientationSensor.start()
      motionAttached = true
    } catch {
      orientationSensor = null
      setUnsupportedOrientationUi()
      return false
    }
  }
  return true
}

async function enableCamera() {
  if (laptopMode) {
    return
  }
  if (cameraStream) return

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    })
    calibrationCamera.srcObject = cameraStream
  } catch {}
}

async function startCalibration() {
  if (laptopMode) return
  if (!isAbsoluteOrientationSupported()) {
    setUnsupportedOrientationUi()
    return
  }
  startCalibrationButton.disabled = true
  try {
    const motionEnabled = await enableMotion()
    if (!motionEnabled) return
    await enableCamera()
    setActiveScreen('calibration')
    setInputStatus('Phone calibration active')
    setCalibrationUi()
  } finally {
    startCalibrationButton.disabled = false
  }
}

function stepBackCalibration() {
  if (calibrationPhase === 'front') {
    setActiveScreen('intro')
    return
  }
  if (calibrationPhase === 'right') {
    calibrationSamples.front = null
    calibrationPhase = 'front'
    setCalibrationUi()
    return
  }
  return
}

function initializeButtons() {
  for (const spec of buttonSpecs) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = spec.label

    const setPressed = (pressed: boolean) => {
      if (buttons[spec.key] === pressed) return
      buttons[spec.key] = pressed
      button.classList.toggle('is-active', pressed)
      sendButtonEvent(spec.key, pressed)
      queueFrameIfChanged(true)
    }

    button.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      button.setPointerCapture(event.pointerId)
      setPressed(true)
    })
    button.addEventListener('pointerup', (event) => {
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId)
      }
      setPressed(false)
    })
    button.addEventListener('pointercancel', (event) => {
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId)
      }
      setPressed(false)
    })
    button.addEventListener('lostpointercapture', () => setPressed(false))
    button.addEventListener('pointerleave', (event) => {
      if ((event.buttons & 1) === 0) setPressed(false)
    })

    buttonGrid.appendChild(button)
  }
}

function initializeAimPad() {
  if (!aimPad) return
  const setLaptopAccelerating = (pressed: boolean) => {
    if (!laptopMode || buttons.accelerate === pressed) return
    buttons.accelerate = pressed
    sendButtonEvent('accelerate', pressed)
    queueFrameIfChanged(true)
  }
  const updateFromEvent = (event: PointerEvent) => {
    event.preventDefault()
    updateAimFromPointer(event.clientX, event.clientY)
  }

  aimPad.addEventListener('pointerdown', (event) => {
    aimPad.setPointerCapture(event.pointerId)
    updateFromEvent(event)
    setLaptopAccelerating(true)
  })
  aimPad.addEventListener('pointermove', (event) => {
    if ((event.buttons & 1) !== 0) {
      updateFromEvent(event)
      setLaptopAccelerating(true)
    }
  })
  aimPad.addEventListener('pointerup', (event) => {
    if (aimPad.hasPointerCapture(event.pointerId)) {
      aimPad.releasePointerCapture(event.pointerId)
    }
    setLaptopAccelerating(false)
  })
  aimPad.addEventListener('pointercancel', (event) => {
    if (aimPad.hasPointerCapture(event.pointerId)) {
      aimPad.releasePointerCapture(event.pointerId)
    }
    setLaptopAccelerating(false)
  })
  aimPad.addEventListener('lostpointercapture', () => {
    setLaptopAccelerating(false)
  })
}

function clearPeerReconnectTimer() {
  if (peerReconnectTimer != null) {
    window.clearTimeout(peerReconnectTimer)
    peerReconnectTimer = null
  }
}

function schedulePeerReconnect(delayMs = 1500) {
  if (peerReconnectTimer != null) return
  peerReconnectTimer = window.setTimeout(() => {
    peerReconnectTimer = null
    if (peer && peer.open && !peer.destroyed) {
      openArtworkConnection()
      return
    }
    connectPeerServer()
  }, delayMs)
}

function attachConnection(connection: DataConnection) {
  controlConnection = connection
  logWebRtc('connection-created', {
    label: connection.label,
    peer: connection.peer,
  })

  connection.on('open', () => {
    clearPeerReconnectTimer()
    setTransportStatus(`Connected via PeerJS ${peerHost}:${peerPort}`)
    logWebRtc('connection-open', {
      label: connection.label,
      peer: connection.peer,
    })
    connection.send(buildHelloPacket())
    for (const packet of pendingButtonEvents.values()) {
      sendPendingButtonEvent(packet)
    }
    queueFrameIfChanged(true)
  })

  connection.on('data', (data) => {
    logWebRtc('connection-data', {
      peer: connection.peer,
      type: isDomeControlPacket(data) ? data.type : typeof data,
    })
    if (!isDomeControlPacket(data)) return
    if (data.type === 'controller-button-ack') {
      handleButtonAck(data)
    }
  })

  connection.on('close', () => {
    if (controlConnection === connection) {
      controlConnection = null
    }
    setTransportStatus('PeerJS connection closed')
    logWebRtc('connection-close', {
      label: connection.label,
      peer: connection.peer,
    })
    schedulePeerReconnect()
  })

  connection.on('error', (error) => {
    logWebRtc('connection-error', {
      label: connection.label,
      peer: connection.peer,
      error: error instanceof Error ? error.message : String(error),
    })
    setTransportStatus('PeerJS connection error')
    schedulePeerReconnect()
  })
}

function openArtworkConnection() {
  if (!peer || !peer.open || peer.destroyed) return
  if (controlConnection?.open) return

  controlConnection?.close()
  const connection = peer.connect(artworkPeerId, {
    label: 'dome-control',
    metadata: { sessionId, controllerId },
    reliable: true,
    serialization: 'json',
  })
  attachConnection(connection)
}

function destroyPeer() {
  controlConnection?.close()
  controlConnection = null
  peer?.destroy()
  peer = null
}

function connectPeerServer() {
  destroyPeer()
  setTransportStatus(`Connecting via PeerJS ${peerHost}:${peerPort}`)
  logWebRtc('peer-connecting', {
    peerHost,
    peerPort,
    peerPath,
    peerSecure,
    peerConfig: summarizePeerConfig(peerConfig),
  })

  peer = new Peer(controllerId, {
    host: peerHost,
    port: peerPort,
    path: peerPath,
    secure: peerSecure,
    debug: webrtcLogEnabled ? 3 : 1,
    config: peerConfig,
  })

  peer.on('open', (id) => {
    setTransportStatus(`PeerJS ready ${id}`)
    logWebRtc('peer-open', { id })
    openArtworkConnection()
  })

  peer.on('disconnected', () => {
    setTransportStatus('PeerJS disconnected')
    logWebRtc('peer-disconnected')
    schedulePeerReconnect()
  })

  peer.on('close', () => {
    setTransportStatus('PeerJS closed')
    logWebRtc('peer-close')
    schedulePeerReconnect()
  })

  peer.on('error', (error) => {
    setTransportStatus('PeerJS error')
    logWebRtc('peer-error', {
      error: error instanceof Error ? error.message : String(error),
    })
    schedulePeerReconnect()
  })
}

function sendGoodbye() {
  const packet = buildGoodbyePacket()
  const directTarget = findArtworkTarget()
  if (directTarget?.removeController) {
    directTarget.removeController(controllerId)
    return
  }

  if (controlConnection?.open) {
    controlConnection.send(packet)
  }
}

startCalibrationButton.addEventListener('click', () => {
  void startCalibration()
})

backCalibrationButton.addEventListener('click', () => {
  stepBackCalibration()
})

confirmAlignmentButton.addEventListener('click', () => {
  confirmCalibrationStep()
})

window.addEventListener('pagehide', () => {
  sendGoodbye()
})

window.addEventListener('beforeunload', () => {
  sendGoodbye()
})

initializeButtons()
initializeAimPad()
if (laptopMode) {
  calibrationPhase = 'done'
  setInputStatus('Laptop joystick active')
} else {
  setActiveScreen('intro')
  if (isAbsoluteOrientationSupported()) {
    setInputStatus('Awaiting phone calibration')
  } else {
    setUnsupportedOrientationUi()
  }
}
syncCursorFromDirection()
setCalibrationUi()
connectPeerServer()
queueFrameIfChanged(true)

window.setInterval(() => {
  queueFrameIfChanged(true)
  sendHeartbeat()
}, 250)
