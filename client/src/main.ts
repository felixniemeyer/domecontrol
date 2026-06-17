import './style.css'

import { mat3, vec2, vec3 } from 'gl-matrix'
import { DataConnection, Peer } from 'peerjs'
import {
  DOME_CONTROL_PROTOCOL,
  REGISTRY_PATH,
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
} from '@dome-control/runtime'

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
// Laptop / joystick mode is the default (no sensors needed).
// Use ?osensor (or ?osensor=1) for explicit orientation sensor / phone tilt mode.
// ?laptop=0 can still be used to force sensor mode.
const forceOsensor = query.has('osensor') || query.get('osensor') === '1'
const laptopMode = !forceOsensor && query.get('laptop') !== '0'
// Session/artwork are now learned from the registry on selection, not fixed.
let sessionId = query.get('session') ?? 'fabric-artwork-local'
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
let calibrationActive = false
let hasSensorSample = false
let motionAttached = false
let orientationSensor: AbsoluteOrientationSensorInstance | null = null
let inputSequence = 0
let peer: Peer | null = null
let controlConnection: DataConnection | null = null
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
  introTitle.textContent = "Your browser or phone does not support absolute orientation measuring. We're sorry."
  startCalibrationButton.hidden = true
  setInputStatus('Absolute orientation unavailable')
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

  if (calibrationPhase === 'front') {
    sendAlignment('front')
    calibrationScreen.dataset.phase = 'front'
    calibrationHeading.textContent = 'front'
    confirmAlignmentButton.textContent = 'Confirm'
    confirmAlignmentButton.disabled = !hasSensorSample
    backCalibrationButton.textContent = 'Back'
    return
  }

  if (calibrationPhase === 'right') {
    sendAlignment('right')
    calibrationScreen.dataset.phase = 'right'
    calibrationHeading.textContent = 'right'
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
  calibrationActive = true
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
  await enterImmersiveMobileMode()
  if (!isAbsoluteOrientationSupported()) {
    setUnsupportedOrientationUi()
    return
  }
  startCalibrationButton.disabled = true
  try {
    const motionEnabled = await enableMotion()
    if (!motionEnabled) return
    await enableCamera()
    calibrationActive = true
    setActiveScreen('calibration')
    setInputStatus('Phone calibration active')
    setCalibrationUi()
  } finally {
    startCalibrationButton.disabled = false
  }
}

function stepBackCalibration() {
  if (calibrationPhase === 'front') {
    calibrationActive = false
    hasSensorSample = false
    sendAlignment(null)
    calibrationPreview.hidden = true
    confirmAlignmentButton.disabled = true
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
    if (peer && peer.open && !peer.destroyed) {
      openArtworkConnection()
      return
    }
    connectPeerServer()
  }, delayMs)
}

function attachConnection(connection: DataConnection) {
  controlConnection = connection

  connection.on('open', () => {
    clearPeerReconnectTimer()
    setTransportStatus(`Connected via PeerJS ${peerHost}:${peerPort}`)
    logClient('connection-open', {
      remotePeerId: connection.peer,
    })
    forceLogNextInput = true
    sendAlignment(calibrationPhase === 'done' ? null : calibrationPhase, true)
    sendCurrentInput()
  })

  connection.on('close', () => {
    if (controlConnection === connection) {
      controlConnection = null
    }
    setTransportStatus('PeerJS connection closed')
    logClient('connection-close', {
      remotePeerId: connection.peer,
    })
    schedulePeerReconnect()
  })

  connection.on('error', (error) => {
    setTransportStatus('PeerJS connection error')
    logClient('connection-error', {
      remotePeerId: connection.peer,
      error: error instanceof Error ? error.message : String(error),
    })
    schedulePeerReconnect()
  })
}

function openArtworkConnection() {
  if (!selectedArtworkId) return
  if (!peer || !peer.open || peer.destroyed) return
  if (controlConnection?.open) return

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

  attachConnection(connection)
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
  if (isAbsoluteOrientationSupported()) {
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
subscribeDirectory()
connectPeerServer()
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
