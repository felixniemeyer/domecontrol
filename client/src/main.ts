import './style.css'

import { mat3, vec2, vec3 } from 'gl-matrix'
import { Peer } from 'peerjs'
import {
  DOME_CONTROL_PROTOCOL,
  REGISTRY_PATH,
  WebSocketClientTransport,
  camDirToDomemaster,
  domemasterToCamDir,
  fetchServerConfig,
  subscribeArtworkDirectory,
  type ArtworkDescriptor,
  type ArtworkDirectorySubscription,
  type ControllerAlignmentCross,
  type ControllerAlignmentPacket,
  type ControllerButtons,
  type ControllerInputPacket,
  type ControllerInputState,
  type ControllerGoodbyePacket,
  type DomeControlConnection,
} from '@dome-control/runtime'

type CalibrationDirection = ControllerAlignmentCross
type CalibrationPhase = 'center' | CalibrationDirection | 'done'

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

type DeviceOrientationPermissionState = 'granted' | 'denied' | 'prompt'

type DeviceOrientationEventConstructorWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: (absolute?: boolean) => Promise<DeviceOrientationPermissionState>
}

type OrientationLockRequest =
  | 'any'
  | 'natural'
  | 'landscape'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary'
  | 'landscape-primary'
  | 'landscape-secondary'

type ScreenOrientationWithLock = ScreenOrientation & {
  lock?: (orientation: OrientationLockRequest) => Promise<void>
}

const buttonSpecs: Array<{ key: keyof ControllerButtons; label: string }> = [
  { key: 'accelerate', label: 'Accelerate' },
]

const query = new URLSearchParams(window.location.search)
// Orientation sensor / phone tilt mode is the default.
// Use ?laptop (or ?laptop=1) for explicit laptop / joystick mode.
// ?osensor=0 can still be used to force laptop mode.
const laptopParam = query.get('laptop')
const forceLaptop = laptopParam === '' || laptopParam === '1'
const laptopMode = forceLaptop || query.get('osensor') === '0'
// Transport: the WebSocket relay is the default (exhibit). ?transport=webrtc keeps
// the legacy PeerJS path for dev.
const useWebsocket = (query.get('transport') ?? 'ws') !== 'webrtc'
const transportName = useWebsocket ? 'WS relay' : 'PeerJS'
// WebRTC learns the session from the registry on selection; WS uses a fixed one
// that must match the artwork host (default 'stardust').
let sessionId = query.get('session') ?? (useWebsocket ? 'stardust' : 'fabric-artwork-local')
const controllerId = query.get('controller') ?? `controller-${Math.random().toString(36).slice(2, 8)}`
const peerId = `controller-peer-${Math.random().toString(36).slice(2, 10)}`
// Escape hatch: force a specific artwork peer id (skips the chooser/registry).
const forcedArtworkPeerId = query.get('artwork-peer')
// Optional pre-selection by registered name (skips the chooser when it appears).
const preferredArtworkName = query.get('artwork')
const registryPort = Number(query.get('registry-port') ?? 8082)
const exhibitPassword = query.get('password') || query.get('pw') || undefined
let selectedArtworkId: string | null = forcedArtworkPeerId
let directorySubscription: ArtworkDirectorySubscription | null = null
// ICE servers dictated by the server (LAN => []); fetched once, reused on reconnect.
let iceServers: RTCIceServer[] | null = null
const forcedPeerHost = query.get('peer-host') || query.get('broker-host') || undefined
const peerHost = forcedPeerHost || window.location.hostname || '127.0.0.1'
const peerSecure = window.location.protocol === 'https:'
const forcedPeerPort = query.get('peer-port') || query.get('broker-port') || undefined
const peerPort = forcedPeerPort ? Number(forcedPeerPort) : (peerSecure ? Number(window.location.port || 443) : 8081)
const peerPath = '/peerjs'
// WebSocket relay endpoint (player input transport). Fixed IP is the user's
// config; we derive the host from where the page is served unless overridden.
const relayPort = Number(query.get('relay-port') ?? 8083)
const relayUrl = query.get('relay') || (peerSecure ? `wss://${window.location.host}/ws-relay` : `ws://${peerHost}:${relayPort}`)
const controllerColor = query.get('color') || '#8bd3ff'
const wsTransport = useWebsocket ? new WebSocketClientTransport(relayUrl, sessionId) : null

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
const scratchOrientation = mat3.create()
const deviceSampleMatrix = mat3.create()
const inverseDeviceSampleMatrix = mat3.create()
const calibrationCoefficients = vec3.create()

const elevatedCrossAngleRadians = 20 * Math.PI / 180
const elevatedCrossHorizontal = Math.cos(elevatedCrossAngleRadians)
const elevatedCrossForward = Math.sin(elevatedCrossAngleRadians)
const calibrationTargetDirections: Record<CalibrationDirection, vec3> = {
  top: vec3.fromValues(0, 0, 1),
  right: vec3.fromValues(elevatedCrossHorizontal, 0, elevatedCrossForward),
  back: vec3.fromValues(0, -elevatedCrossHorizontal, elevatedCrossForward),
}

const calibrationSamples: Record<CalibrationDirection, CalibrationSample | null> = {
  top: null,
  right: null,
  back: null,
}

let calibrationPhase: CalibrationPhase = 'center'
let calibrationActive = false
let hasSensorSample = false
let motionAttached = false
let orientationSensor: AbsoluteOrientationSensorInstance | null = null
let legacyMotionAttached = false
let inputSequence = 0
let peer: Peer | null = null
let controlConnection: DomeControlConnection | null = null
let cameraStream: MediaStream | null = null
let transportLabel = 'Disconnected'
let inputLabel = 'Pointer aiming active'
let lastSentAlignmentCross: ControllerAlignmentCross | null | undefined
let peerReconnectTimer: number | null = null
let pageIsLeaving = false
const inputSendIntervalMs = 1000 / 60
let forceLogNextInput = true
let lastLoggedInputSequence = 0
let lastLoggedAccelerate = buttons.accelerate

function logClient(event: string, data?: Record<string, unknown>) {
  console.info(`[${new Date().toISOString()}] [dome-control/client] ${event}`, {
    peerId,
    controllerId,
    sessionId,
    ...data,
  })
}

function formatDirectionLog(values: ArrayLike<number>) {
  return [values[0], values[1], values[2]].map((value) => Number((value ?? 0).toFixed(3)))
}

const introScreen = document.getElementById('intro-screen') as HTMLElement
const introTitle = introScreen.querySelector('h1') as HTMLHeadingElement
const calibrationScreen = document.getElementById('calibration-screen') as HTMLElement
const controlScreen = document.getElementById('control-screen') as HTMLElement
const calibrationPreview = document.getElementById('calibration-preview') as HTMLDivElement
const calibrationHeading = document.getElementById('calibration-heading') as HTMLParagraphElement
const calibrationCopy = document.getElementById('calibration-copy') as HTMLParagraphElement
const calibrationCrossShape = document.querySelector<SVGPathElement>('#calibration-cross-shape')!
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
const recalibrateButton = document.getElementById('recalibrate') as HTMLButtonElement
const gameScreen = document.getElementById('game-screen') as HTMLElement
const gameScreenTitle = document.getElementById('game-screen-title') as HTMLHeadingElement
const gameList = document.getElementById('game-list') as HTMLDivElement

function preventLongPressBrowserAction(event: Event) {
  event.preventDefault()
}

type Vec2 = readonly [number, number]

function pathFromPoints(points: Vec2[]) {
  const [[startX, startY], ...rest] = points
  return `M ${startX.toFixed(3)} ${startY.toFixed(3)} ${rest
    .map(([x, y]) => `L ${x.toFixed(3)} ${y.toFixed(3)}`)
    .join(' ')} Z`
}

function buildAxisArrowPath(
  center: Vec2,
  axis: Vec2,
  radius: number,
  halfWidth: number,
  notchDepth: number,
) {
  const [cx, cy] = center
  const [ax, ay] = axis
  const px = -ay
  const py = ax
  const tailAlong = Math.sqrt(Math.max(0, radius * radius - halfWidth * halfWidth))

  const point = (along: number, across: number): Vec2 => [
    cx + ax * along + px * across,
    cy + ay * along + py * across,
  ]

  return pathFromPoints([
    point(-tailAlong, -halfWidth),
    point(radius - notchDepth, -halfWidth),
    point(radius, 0),
    point(radius - notchDepth, halfWidth),
    point(-tailAlong, halfWidth),
    point(-tailAlong + notchDepth, 0),
  ])
}

function buildCalibrationCrossPath() {
  const center: Vec2 = [50, 50]
  const radius = 43
  const halfWidth = 5.5
  const notchDepth = 11
  return [
    buildAxisArrowPath(center, [1, 0], radius, halfWidth, notchDepth),
    buildAxisArrowPath(center, [0, -1], radius, halfWidth, notchDepth),
  ].join(' ')
}

calibrationCrossShape.setAttribute('d', buildCalibrationCrossPath())

function setTransportStatus(label: string) {
  transportLabel = label
  transportStatus.textContent = `${label} · ${controllerId}`
}

function setInputStatus(label: string) {
  inputLabel = label
  inputStatus.textContent = label
}

function setUnsupportedOrientationUi() {
  calibrationActive = false
  setActiveScreen('intro')
  introTitle.textContent = "Your browser or phone does not support orientation measuring. We're sorry."
  startCalibrationButton.hidden = true
  setInputStatus('Orientation unavailable')
}

function setActiveScreen(screen: 'intro' | 'calibration' | 'control') {
  introScreen.hidden = screen !== 'intro'
  calibrationScreen.hidden = screen !== 'calibration'
  controlScreen.hidden = screen !== 'control'
}

// --- artwork discovery ---------------------------------------------------

function registryUrl() {
  // https client reaches the registry same-origin (proxied); http connects direct.
  return peerSecure
    ? `wss://${window.location.host}${REGISTRY_PATH}`
    : `ws://${peerHost}:${registryPort}${REGISTRY_PATH}`
}

function showGameChooser(artworks: ArtworkDescriptor[]) {
  gameScreenTitle.textContent = 'Choose a game'
  gameList.replaceChildren(
    ...artworks.map((artwork) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = artwork.name
      button.addEventListener('click', () => selectArtwork(artwork))
      return button
    }),
  )
  gameScreen.hidden = false
}

function showWaitingForGame() {
  gameScreenTitle.textContent = 'Waiting for an available game…'
  gameList.replaceChildren()
  gameScreen.hidden = false
}

function selectArtwork(artwork: ArtworkDescriptor) {
  selectedArtworkId = artwork.id
  sessionId = artwork.sessionId
  logClient('artwork-selected', { name: artwork.name, id: artwork.id, sessionId })
  gameScreen.hidden = true
  forceLogNextInput = true
  openArtworkConnection()
}

function handleDirectory(artworks: ArtworkDescriptor[]) {
  // Forced peer id ignores the chooser entirely.
  if (forcedArtworkPeerId) return

  // If our chosen game vanished, drop the connection and re-choose.
  if (selectedArtworkId && !artworks.some((artwork) => artwork.id === selectedArtworkId)) {
    logClient('artwork-unregistered', { id: selectedArtworkId })
    selectedArtworkId = null
    controlConnection?.close()
    controlConnection = null
  }

  if (selectedArtworkId) {
    gameScreen.hidden = true
    return
  }

  const preferred = preferredArtworkName
    ? artworks.find((artwork) => artwork.name === preferredArtworkName)
    : undefined
  if (preferred) {
    selectArtwork(preferred)
  } else if (artworks.length === 0) {
    showWaitingForGame()
  } else if (artworks.length === 1) {
    selectArtwork(artworks[0]!)
  } else {
    showGameChooser(artworks)
  }
}

function subscribeDirectory() {
  if (forcedArtworkPeerId || directorySubscription) return
  directorySubscription = subscribeArtworkDirectory({
    url: registryUrl(),
    credential: exhibitPassword,
    onUpdate: handleDirectory,
  })
}

function setCalibrationUi() {
  if (laptopMode) {
    sendAlignment(null)
    setActiveScreen('control')
    controlScreen.dataset.mode = 'laptop'
    laptopJoystickPanel.hidden = false
    recalibrateButton.hidden = true
    controlEyebrow.textContent = 'dome-control'
    controlTitle.textContent = 'Laptop controls'
    controlCopy.textContent = 'Laptop mode: drag the joystick to aim and hold accelerate.'
    return
  }

  setActiveScreen(calibrationPhase === 'done' ? 'control' : 'calibration')
  controlScreen.dataset.mode = 'phone'
  laptopJoystickPanel.hidden = true
  recalibrateButton.hidden = calibrationPhase !== 'done'
  controlEyebrow.textContent = 'dome-control'
  controlTitle.textContent = 'Phone controls'
  controlCopy.textContent = 'Point your phone into the direction you want to go and accelerate.'
  calibrationPreview.hidden = false
  confirmAlignmentButton.hidden = calibrationPhase === 'done'
  backCalibrationButton.hidden = calibrationPhase === 'done'

  if (calibrationPhase === 'center') {
    sendAlignment(null)
    calibrationScreen.dataset.phase = 'center'
    calibrationHeading.textContent = 'go close to the center of the dome for calibration'
    calibrationCopy.textContent = ''
    confirmAlignmentButton.textContent = "I'm near the center"
    confirmAlignmentButton.disabled = false
    backCalibrationButton.textContent = 'Back'
    return
  }

  if (calibrationPhase === 'top') {
    sendAlignment('top')
    calibrationScreen.dataset.phase = 'top'
    calibrationHeading.textContent = 'top'
    calibrationCopy.textContent = 'Point the cross to the equal color cross on the dome and confirm'
    confirmAlignmentButton.textContent = 'Confirm'
    confirmAlignmentButton.disabled = !hasSensorSample
    backCalibrationButton.textContent = 'Back'
    return
  }

  if (calibrationPhase === 'right') {
    sendAlignment('right')
    calibrationScreen.dataset.phase = 'right'
    calibrationHeading.textContent = 'right'
    calibrationCopy.textContent = 'Point the cross to the equal color cross on the dome and confirm'
    confirmAlignmentButton.textContent = 'Confirm'
    confirmAlignmentButton.disabled = !hasSensorSample
    backCalibrationButton.textContent = 'Back'
    return
  }

  if (calibrationPhase === 'back') {
    sendAlignment('back')
    calibrationScreen.dataset.phase = 'back'
    calibrationHeading.textContent = 'back'
    calibrationCopy.textContent = 'Point the cross to the equal color cross on the dome and confirm'
    confirmAlignmentButton.textContent = 'Confirm'
    confirmAlignmentButton.disabled = !hasSensorSample
    backCalibrationButton.textContent = 'Back'
    return
  }

  sendAlignment(null)
  confirmAlignmentButton.hidden = true
  backCalibrationButton.hidden = true
  calibrationPreview.hidden = true
  confirmAlignmentButton.disabled = false
}

function buildInputState(): ControllerInputState {
  inputSequence += 1
  return {
    direction: [direction[0], direction[1], direction[2]],
    accelerate: buttons.accelerate,
    sequence: inputSequence,
    sentAt: performance.now() * 0.001,
    color: '#8bd3ff',
  }
}

function buildInputPacket(input: ControllerInputState): ControllerInputPacket {
  return {
    protocol: DOME_CONTROL_PROTOCOL,
    type: 'controller-input',
    sessionId,
    controllerId,
    input,
  }
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

function updateDiagnostics(packet: ControllerInputPacket | ControllerAlignmentPacket | ControllerGoodbyePacket) {
  if (controllerState) {
    controllerState.textContent = JSON.stringify(
      {
        sessionId,
        controllerId,
        direction: [direction[0], direction[1], direction[2]],
        accelerate: buttons.accelerate,
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

function buildAlignmentPacket(cross: ControllerAlignmentCross | null): ControllerAlignmentPacket {
  return {
    protocol: DOME_CONTROL_PROTOCOL,
    type: 'controller-alignment',
    sessionId,
    controllerId,
    cross,
    sentAt: performance.now() * 0.001,
  }
}

function sendCurrentInput() {
  const input = buildInputState()
  const packet = buildInputPacket(input)

  if (controlConnection?.open) {
    controlConnection.send(packet)
    setTransportStatus(`Connected via PeerJS ${peerHost}:${peerPort}`)
  } else {
    setTransportStatus('Disconnected')
  }

  if (
    forceLogNextInput
    || input.accelerate !== lastLoggedAccelerate
    || (input.sequence ?? 0) - lastLoggedInputSequence >= 120
  ) {
    logClient('input-send', {
      sequence: input.sequence,
      accelerate: input.accelerate,
      direction: formatDirectionLog(input.direction),
      connectionOpen: Boolean(controlConnection?.open),
    })
    forceLogNextInput = false
    lastLoggedInputSequence = input.sequence ?? lastLoggedInputSequence
    lastLoggedAccelerate = input.accelerate
  }

  updateDiagnostics(packet)
}

function sendAlignment(cross: ControllerAlignmentCross | null, force = false) {
  if (!force && lastSentAlignmentCross === cross) return
  lastSentAlignmentCross = cross

  if (controlConnection?.open) {
    const packet = buildAlignmentPacket(cross)
    controlConnection.send(packet)
    updateDiagnostics(packet)
  }
}

function currentAlignmentCross(): ControllerAlignmentCross | null {
  return calibrationPhase === 'top' || calibrationPhase === 'right' || calibrationPhase === 'back'
    ? calibrationPhase
    : null
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
  vec3.transformMat3(calibrationCoefficients, vector, inverseDeviceSampleMatrix)
  vec3.zero(out)
  vec3.scaleAndAdd(out, out, calibrationTargetDirections.top, calibrationCoefficients[0])
  vec3.scaleAndAdd(out, out, calibrationTargetDirections.right, calibrationCoefficients[1])
  vec3.scaleAndAdd(out, out, calibrationTargetDirections.back, calibrationCoefficients[2])
  if (vec3.squaredLength(out) < 1e-8) {
    vec3.set(out, 0, 0, 1)
  } else {
    vec3.normalize(out, out)
  }
}

function tryBuildCalibrationBasis() {
  const topSample = calibrationSamples.top
  const rightSample = calibrationSamples.right
  const backSample = calibrationSamples.back
  if (!topSample || !rightSample || !backSample) return false

  deviceSampleMatrix[0] = topSample.forward[0]
  deviceSampleMatrix[1] = topSample.forward[1]
  deviceSampleMatrix[2] = topSample.forward[2]
  deviceSampleMatrix[3] = rightSample.forward[0]
  deviceSampleMatrix[4] = rightSample.forward[1]
  deviceSampleMatrix[5] = rightSample.forward[2]
  deviceSampleMatrix[6] = backSample.forward[0]
  deviceSampleMatrix[7] = backSample.forward[1]
  deviceSampleMatrix[8] = backSample.forward[2]

  return Boolean(mat3.invert(inverseDeviceSampleMatrix, deviceSampleMatrix))
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
  calibrationSamples.top = null
  calibrationSamples.right = null
  calibrationSamples.back = null
  mat3.identity(deviceSampleMatrix)
  mat3.identity(inverseDeviceSampleMatrix)
  calibrationPhase = 'center'
  calibrationActive = true
  setInputStatus('Awaiting phone calibration')
  setCalibrationUi()
}

function confirmCalibrationStep() {
  if (laptopMode) {
    return
  }

  if (calibrationPhase === 'center') {
    calibrationPhase = 'top'
    setCalibrationUi()
    return
  }

  const sample = captureCurrentSample()
  if (!sample) return

  if (calibrationPhase === 'top') {
    calibrationSamples.top = sample
    calibrationPhase = 'right'
    setCalibrationUi()
    return
  }

  if (calibrationPhase === 'right') {
    calibrationSamples.right = sample
    calibrationPhase = 'back'
    setCalibrationUi()
    return
  }

  if (calibrationPhase === 'back') {
    calibrationSamples.back = sample
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

function getDeviceOrientationEventConstructor() {
  return (window as Window & {
    DeviceOrientationEvent?: DeviceOrientationEventConstructorWithPermission
  }).DeviceOrientationEvent
}

function isLegacyDeviceOrientationSupported() {
  return typeof getDeviceOrientationEventConstructor() === 'function' && 'ondeviceorientation' in window
}

function isMotionOrientationSupported() {
  return isAbsoluteOrientationSupported() || isLegacyDeviceOrientationSupported()
}

function isMobileViewport() {
  return window.matchMedia('(hover: none), (pointer: coarse)').matches
}

async function enterImmersiveMobileMode() {
  const fullscreenTarget = document.documentElement
  try {
    if (!document.fullscreenElement && fullscreenTarget.requestFullscreen) {
      await fullscreenTarget.requestFullscreen({ navigationUI: 'hide' })
    }
  } catch (error) {
    logClient('fullscreen-unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (!isMobileViewport()) {
    return
  }

  const orientation = screen.orientation as ScreenOrientationWithLock | undefined
  if (!orientation?.lock) {
    return
  }

  try {
    await orientation.lock('portrait-primary')
  } catch (error) {
    logClient('orientation-lock-unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
  handleMotionSample()
}

function setDeviceOrientationMatrix(out: mat3, alpha: number, beta: number, gamma: number) {
  const x = beta * Math.PI / 180
  const y = gamma * Math.PI / 180
  const z = alpha * Math.PI / 180
  const a = Math.cos(x)
  const b = Math.sin(x)
  const c = Math.cos(y)
  const d = Math.sin(y)
  const e = Math.cos(z)
  const f = Math.sin(z)

  // DeviceOrientationEvent is defined as intrinsic Z-X'-Y'' rotations:
  // alpha around Z, beta around the rotated X axis, gamma around the rotated
  // Y axis. Store the spec's row-major matrix in gl-matrix column-major order.
  out[0] = e * c - f * b * d
  out[1] = c * f + e * b * d
  out[2] = -a * d
  out[3] = -a * f
  out[4] = e * a
  out[5] = b
  out[6] = c * f * b + e * d
  out[7] = f * d - e * c * b
  out[8] = a * c
}

function onLegacyDeviceOrientation(event: DeviceOrientationEvent) {
  if (event.alpha == null || event.beta == null || event.gamma == null) {
    return
  }

  setDeviceOrientationMatrix(scratchOrientation, event.alpha, event.beta, event.gamma)
  mat3.rotate(scratchOrientation, scratchOrientation, -currentScreenAngleRadians())
  vec3.transformMat3(rawForward, localDeviceForward, scratchOrientation)
  vec3.transformMat3(rawRight, localDeviceRight, scratchOrientation)
  handleMotionSample()
}

function handleMotionSample() {
  vec3.normalize(rawForward, rawForward)
  vec3.normalize(rawRight, rawRight)
  hasSensorSample = true

  if (calibrationPhase === 'done') {
    projectVectorIntoCalibration(calibratedForward, rawForward)
    applyControllerDirection(calibratedForward, 'Motion aiming active')
    return
  }

  if (calibrationActive) {
    setInputStatus('Motion sample ready for calibration')
    setCalibrationUi()
  }
}

async function enableMotion() {
  if (laptopMode) {
    return true
  }
  const AbsoluteOrientationSensorCtor = getAbsoluteOrientationSensorConstructor()

  if (AbsoluteOrientationSensorCtor && !motionAttached) {
    try {
      orientationSensor = new AbsoluteOrientationSensorCtor({
        frequency: 60,
        referenceFrame: 'device',
      })
      orientationSensor.addEventListener('reading', onAbsoluteOrientationReading)
      orientationSensor.addEventListener('error', (event) => {
        logClient('orientation-sensor-error', {
          error: 'error' in event && event.error instanceof Error ? event.error.message : 'unknown',
        })
        setUnsupportedOrientationUi()
      })
      orientationSensor.start()
      motionAttached = true
      logClient('orientation-sensor-started')
    } catch (error) {
      orientationSensor = null
      logClient('orientation-sensor-start-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      setUnsupportedOrientationUi()
      return false
    }
  }

  if (!motionAttached && !legacyMotionAttached) {
    const DeviceOrientationEventCtor = getDeviceOrientationEventConstructor()
    if (!DeviceOrientationEventCtor) {
      setUnsupportedOrientationUi()
      return false
    }

    try {
      const requestPermission = DeviceOrientationEventCtor.requestPermission
      if (typeof requestPermission === 'function') {
        const permission = await requestPermission(true)
        if (permission !== 'granted') {
          logClient('legacy-orientation-permission-denied', { permission })
          setUnsupportedOrientationUi()
          return false
        }
      }

      window.addEventListener('deviceorientation', onLegacyDeviceOrientation)
      legacyMotionAttached = true
      logClient('legacy-orientation-started')
    } catch (error) {
      logClient('legacy-orientation-start-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
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
    logClient('camera-started')
  } catch (error) {
    logClient('camera-unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function startCalibration() {
  if (laptopMode) return
  logClient('calibration-start-clicked')
  calibrationActive = true
  calibrationPhase = 'center'
  setActiveScreen('calibration')
  setInputStatus('Phone calibration active')
  setCalibrationUi()

  void enterImmersiveMobileMode()
  if (!isMotionOrientationSupported()) {
    setUnsupportedOrientationUi()
    return
  }
  startCalibrationButton.disabled = true
  try {
    const motionEnabled = await enableMotion()
    if (!motionEnabled) return
    void enableCamera()
  } finally {
    startCalibrationButton.disabled = false
  }
}

function stepBackCalibration() {
  if (calibrationPhase === 'center') {
    calibrationActive = false
    hasSensorSample = false
    sendAlignment(null)
    calibrationPreview.hidden = true
    confirmAlignmentButton.disabled = true
    setActiveScreen('intro')
    return
  }
  if (calibrationPhase === 'top') {
    calibrationPhase = 'center'
    sendAlignment(null)
    setCalibrationUi()
    return
  }
  if (calibrationPhase === 'right') {
    calibrationSamples.top = null
    calibrationPhase = 'top'
    setCalibrationUi()
    return
  }
  if (calibrationPhase === 'back') {
    calibrationSamples.right = null
    calibrationPhase = 'right'
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
    let activePointerId: number | null = null

    const setPressed = (pressed: boolean) => {
      if (buttons[spec.key] === pressed) return
      buttons[spec.key] = pressed
      button.classList.toggle('is-active', pressed)
    }
    const releasePointer = (pointerId: number) => {
      if (button.hasPointerCapture(pointerId)) {
        button.releasePointerCapture(pointerId)
      }
      if (activePointerId === pointerId) {
        activePointerId = null
        setPressed(false)
      }
    }
    const preventDefaultPressBehavior = (event: Event) => {
      event.preventDefault()
    }

    button.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || activePointerId != null) return
      event.preventDefault()
      activePointerId = event.pointerId
      button.setPointerCapture(event.pointerId)
      setPressed(true)
    })
    button.addEventListener('pointerup', (event) => {
      event.preventDefault()
      releasePointer(event.pointerId)
    })
    button.addEventListener('pointercancel', (event) => {
      event.preventDefault()
      releasePointer(event.pointerId)
    })
    button.addEventListener('lostpointercapture', (event) => {
      if (activePointerId === event.pointerId) {
        activePointerId = null
        setPressed(false)
      }
    })
    button.addEventListener('contextmenu', preventDefaultPressBehavior)
    button.addEventListener('dragstart', preventDefaultPressBehavior)
    button.addEventListener('selectstart', preventDefaultPressBehavior)

    buttonGrid.appendChild(button)
  }
}

function initializeAimPad() {
  if (!aimPad) return
  let activePointerId: number | null = null
  let laptopPointerHeld = false

  const setLaptopAccelerating = (pressed: boolean) => {
    if (!laptopMode) return
    laptopPointerHeld = pressed
    if (buttons.accelerate === laptopPointerHeld) {
      return
    }
    buttons.accelerate = laptopPointerHeld
  }
  const updateFromEvent = (event: PointerEvent) => {
    event.preventDefault()
    updateAimFromPointer(event.clientX, event.clientY)
  }
  const releasePointerState = (pointerId: number | null) => {
    if (pointerId != null && aimPad.hasPointerCapture(pointerId)) {
      aimPad.releasePointerCapture(pointerId)
    }
    if (activePointerId === pointerId) {
      activePointerId = null
    }
    setLaptopAccelerating(false)
  }

  aimPad.addEventListener('pointerdown', (event) => {
    aimPad.setPointerCapture(event.pointerId)
    activePointerId = event.pointerId
    setLaptopAccelerating(true)
    updateFromEvent(event)
  })
  aimPad.addEventListener('pointermove', (event) => {
    if (laptopMode || (event.buttons & 1) !== 0) {
      updateFromEvent(event)
    }
  })
  aimPad.addEventListener('pointerup', (event) => {
    releasePointerState(event.pointerId)
  })
  aimPad.addEventListener('pointercancel', (event) => {
    releasePointerState(event.pointerId)
  })
  aimPad.addEventListener('lostpointercapture', (event) => {
    if (activePointerId === event.pointerId) {
      activePointerId = null
    }
  })
  window.addEventListener('mouseup', () => {
    setLaptopAccelerating(false)
  })
  window.addEventListener('blur', () => {
    releasePointerState(activePointerId)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releasePointerState(activePointerId)
    }
  })
}

function clearPeerReconnectTimer() {
  if (peerReconnectTimer != null) {
    window.clearTimeout(peerReconnectTimer)
    peerReconnectTimer = null
  }
}

function schedulePeerReconnect(delayMs = 1500) {
  if (pageIsLeaving) return
  if (peerReconnectTimer != null) return
  peerReconnectTimer = window.setTimeout(() => {
    peerReconnectTimer = null
    if (useWebsocket) {
      openArtworkConnection()
      return
    }
    if (peer && peer.open && !peer.destroyed) {
      openArtworkConnection()
      return
    }
    connectPeerServer()
  }, delayMs)
}

function attachConnection(connection: DomeControlConnection) {
  controlConnection = connection

  connection.on('open', () => {
    clearPeerReconnectTimer()
    setTransportStatus(`Connected (${transportName})`)
    logClient('connection-open', { artworkId: selectedArtworkId })
    forceLogNextInput = true
    sendAlignment(currentAlignmentCross(), true)
    sendCurrentInput()
  })

  connection.on('close', () => {
    if (controlConnection === connection) {
      controlConnection = null
    }
    setTransportStatus(`${transportName} connection closed`)
    logClient('connection-close', { artworkId: selectedArtworkId })
    schedulePeerReconnect()
  })

  connection.on('error', (error: unknown) => {
    setTransportStatus(`${transportName} connection error`)
    logClient('connection-error', {
      error: error instanceof Error ? error.message : String(error),
    })
    schedulePeerReconnect()
  })
}

function openArtworkConnection() {
  if (!selectedArtworkId) return
  if (controlConnection?.open) return

  // WebSocket relay: no peer server, just open a controller socket.
  if (useWebsocket) {
    controlConnection?.close()
    logClient('connect-attempt', { artworkId: selectedArtworkId })
    attachConnection(
      wsTransport!.connect(selectedArtworkId, {
        sessionId,
        controllerId,
        color: controllerColor,
        credential: exhibitPassword,
      }),
    )
    return
  }

  // --- legacy WebRTC path ---
  if (!peer || !peer.open || peer.destroyed) return

  controlConnection?.close()
  logClient('connect-attempt', {
    artworkPeerId: selectedArtworkId,
  })
  const connection = peer.connect(selectedArtworkId, {
    label: 'dome-control',
    metadata: { sessionId, controllerId, peerId, ...(exhibitPassword ? { password: exhibitPassword } : {}) },
    reliable: true,
    serialization: 'json',
  })

  const timeoutId = window.setTimeout(() => {
    if (!connection.open && controlConnection === connection) {
      connection.close()
      schedulePeerReconnect()
    }
  }, 8000)

  connection.on('open', () => {
    window.clearTimeout(timeoutId)
  })

  connection.on('close', () => {
    window.clearTimeout(timeoutId)
  })

  connection.on('error', () => {
    window.clearTimeout(timeoutId)
  })

  // DataConnection structurally satisfies DomeControlConnection (open/send/close/on).
  attachConnection(connection as unknown as DomeControlConnection)
}

function destroyPeer() {
  clearPeerReconnectTimer()
  controlConnection?.close()
  controlConnection = null
  peer?.destroy()
  peer = null
}

async function connectPeerServer() {
  destroyPeer()
  setTransportStatus(`Connecting via PeerJS ${peerHost}:${peerPort}`)

  if (iceServers === null) {
    iceServers = (await fetchServerConfig(registryUrl())).iceServers
  }

  peer = new Peer(peerId, {
    host: peerHost,
    port: peerPort,
    path: peerPath,
    secure: peerSecure,
    config: { iceServers: iceServers ?? [] },
  })

  peer.on('open', (id) => {
    setTransportStatus(`PeerJS ready ${id}`)
    logClient('peer-open', { id })
    // Reconnect to an already-chosen game (or honour a forced peer id).
    if (selectedArtworkId) openArtworkConnection()
  })

  peer.on('disconnected', () => {
    setTransportStatus('PeerJS disconnected')
    logClient('peer-disconnected')
    schedulePeerReconnect()
  })

  peer.on('close', () => {
    setTransportStatus('PeerJS closed')
    logClient('peer-close')
    schedulePeerReconnect()
  })

  peer.on('error', (error) => {
    setTransportStatus('PeerJS error')
    logClient('peer-error', {
      error: error instanceof Error ? error.message : String(error),
    })
    schedulePeerReconnect()
  })
}

function sendGoodbye() {
  sendAlignment(null, true)
  const packet = buildGoodbyePacket()
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

recalibrateButton.addEventListener('click', () => {
  resetCalibration()
})

document.addEventListener('contextmenu', preventLongPressBrowserAction)
document.addEventListener('selectstart', preventLongPressBrowserAction)
document.addEventListener('dragstart', preventLongPressBrowserAction)

window.addEventListener('pagehide', () => {
  pageIsLeaving = true
  sendGoodbye()
  directorySubscription?.dispose()
  destroyPeer()
})

window.addEventListener('beforeunload', () => {
  pageIsLeaving = true
  sendGoodbye()
  directorySubscription?.dispose()
  destroyPeer()
})

window.addEventListener('pageshow', (event) => {
  if (event.persisted && pageIsLeaving) {
    window.location.reload()
  }
})

initializeButtons()
initializeAimPad()
if (laptopMode) {
  calibrationPhase = 'done'
  setInputStatus('Laptop joystick active')
} else {
  setActiveScreen('intro')
  if (isMotionOrientationSupported()) {
    startCalibrationButton.hidden = false
    introTitle.textContent = 'Calibrate your phone to the dome'
    setInputStatus('Awaiting phone calibration')
  } else {
    setUnsupportedOrientationUi()
  }
}
syncCursorFromDirection()
if (laptopMode) {
  setCalibrationUi()
}
if (!forcedArtworkPeerId) showWaitingForGame()
if (useWebsocket) {
  // Fixed endpoint: the directory yields exactly one artwork → auto-connect.
  wsTransport!.openDirectory().onUpdate(handleDirectory)
} else {
  subscribeDirectory()
  connectPeerServer()
}
sendCurrentInput()

let lastHeartbeatTick = Date.now()

window.setInterval(() => {
  const now = Date.now()
  if (now - lastHeartbeatTick > 20000 && !document.hidden) {
    destroyPeer()
    schedulePeerReconnect(2000)
  }
  lastHeartbeatTick = now

  sendCurrentInput()
}, inputSendIntervalMs)
