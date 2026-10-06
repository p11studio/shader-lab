import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  MAX_PIXEL_RATIO,
  MAX_DELTA_SECONDS,
  computeDepthRange,
  buildMorphParticleData,
  computeMorphTargets,
  createMorphClock,
  stepMorphPhysics,
  hexToVector3,
  loadBrainMaskSampler,
  regenerateBrainTargets,
  createGradientBackgroundTexture,
  createStarField,
  POINTS_VERTEX_SHADER,
  POINTS_FRAGMENT_SHADER,
} from '../brain-particles/shared'

const ROTATION_SPEED_Y = 0.045
// Segundo eje de rotación (más lento, velocidad distinta a la de Y para que
// no se sienta mecánico) para que se perciba el volumen 3D de la forma.
const ROTATION_SPEED_X = 0.027
const CAMERA_FOV = 50
const CAMERA_DISTANCE = 4.2
// Cuántos pulsos de luz viajan por las conexiones a la vez cuando el
// control "Pulsos" está activo.
const PULSE_COUNT = 8
const PULSE_DURATION_SECONDS = 1.4
const TAU = Math.PI * 2

function getLightFieldBreathFactor(time, amplitude, period) {
  const slowPhase = (time / period) * TAU
  const organicPhase = slowPhase + Math.sin((time / (period * 0.73)) * TAU + 1.1) * 0.35
  const organicWave = (Math.sin(organicPhase) + 1) / 2
  return 1 - amplitude * organicWave
}

// --- Líneas con "respiración": shader propio (no LineBasicMaterial) para
// poder variar la opacidad con una fase distinta por línea (aPhase, una por
// arista) y así no respiren todas sincronizadas.
const LINE_VERTEX_SHADER = `
attribute float aPhase;
varying float vPhase;

void main() {
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const LINE_FRAGMENT_SHADER = `
precision mediump float;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uBreatheIntensity;
uniform float uBreathePeriod;
varying float vPhase;

void main() {
  // Oscilación lenta de la opacidad (vPhase corre la fase por línea, así
  // no "laten" todas juntas como si fuera un solo pulso sincronizado).
  float breathe = 1.0 + uBreatheIntensity * sin((uTime / uBreathePeriod) * 6.28318530718 + vPhase);
  gl_FragColor = vec4(uColor, clamp(uOpacity * breathe, 0.0, 1.0));
}
`

// --- Campo de luz
// Fondo: shader @hugol · OpenShaders (https://openshaders.com/@hugol)
// Uso local: verificar licencia del shader concreto en fuente oficial antes de publicar.
// Los uniformes uIntensity/uSpeed/uTint conectan el shader con los controles.
//
// Se integra como una escena aparte con un quad de pantalla completa,
// renderizada con el MISMO renderer/contexto WebGL de la red (antes de
// dibujarla), no como un <canvas> independiente — así en modo Comparar A/B
// no se duplican contextos WebGL.
// Sin "#version 300 es" acá: RawShaderMaterial con glslVersion=THREE.GLSL3
// ya lo antepone solo (ponerlo también duplica la directiva y GLSL la
// rechaza con "must occur before anything else").
const LIGHT_FIELD_VERTEX_SHADER = `
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`

const LIGHT_FIELD_FRAGMENT_SHADER = `
precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform float uIntensity;
uniform float uSpeed;
uniform vec3 uTint;
out vec4 fragColor;

const float HUE = 0.649973691;
const float HUE_SPREAD = 0.0151582006;
const float HUE_TRAVEL = 1.81695879;
const float CHROMA = 0.0991339162;
const float LIGHTNESS = 0.492462546;
const float COLOUR_CYCLE = 0.194465965;
const float THETA = 2.12260175;
const float SHEAR = 0.967797697;
const float SHRINK = 0.95172888;
const float LAYERS = 90.0;
const float WARP_FREQ_X = 0.45280847;
const float WARP_FREQ_Y = 2.39893532;
const float WARP_AMP_X = 0.124454819;
const float WARP_AMP_Y = 0.0231946949;
const float ASPECT_X = 2.25696206;
const float ASPECT_Y = 0.16553168;
const float OFFSET_X = 0.301566422;
const float OFFSET_Y = 0.0272947382;
const float TILT = 2.67930293;
const float ZOOM = 1.14837945;
const float CENTRE_X = -0.0161538161;
const float CENTRE_Y = 0.676150143;
const float GLOW_SIZE = 0.00285176956;
const float FALLOFF = 0.476687223;
const float VIGNETTE = 0.12104886;
const float FLOW_SPEED = 0.402825058;
const float FLOW_DIRECTION = 1.0;
const float BREATH_RATE = 0.436504215;
const float BREATH_AMOUNT = 0.0603934377;
const float PHASE = 53.8537598;
const float ECHO = 0.0;
const float ECHO_SHIFT = 0.157500744;
const float SOFTNESS = 0.0022780383;
const float LIGHT_SWING = 0.309109032;

const float TAU = 6.28318530718;

vec3 oklchToLinear(float L, float C, float h) {
  float a = C * cos(h), b = C * sin(h);
  float l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  float m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  float s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  vec3 lms = vec3(l_, m_, s_);
  lms = lms * lms * lms;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863,
              -3.3077115913, 2.6097574011, -0.7034186147,
              0.2309699292, -0.3413193965, 1.7076147010) * lms;
}

float blueNoise(vec2 p, float frame) {
  p += 5.588238 * mod(frame, 64.0);
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  vec2 R = iResolution.xy;
  vec2 pos = (gl_FragCoord.xy - 0.5 * R) / R.y;
  // uSpeed escala el tiempo entero (así no hay que tocar cada constante de
  // ritmo del shader original por separado).
  float timeScaled = iTime * uSpeed;
  float t = timeScaled * FLOW_SPEED * FLOW_DIRECTION + PHASE;
  float breath = (-sin(timeScaled * BREATH_RATE * 1.5) + sin(timeScaled * BREATH_RATE + 1.0)) * 0.25 + 0.5;

  vec2 u = (pos - vec2(CENTRE_X, CENTRE_Y)) * (ZOOM - breath * BREATH_AMOUNT);
  float ct = cos(TILT), st = sin(TILT);
  u = mat2(ct, st, -st, ct) * u;

  mat2 fold = mat2(cos(THETA), sin(THETA), -SHEAR, cos(THETA));

  float hue0 = HUE * TAU;
  float hue1 = hue0 + HUE_SPREAD * TAU;
  vec3 color = vec3(0.0);

  for (float i = 1.0; i <= 96.0; i += 1.0) {
    if (i > LAYERS) break;
    u.x += -sin(u.y * WARP_FREQ_X + t + i * 0.007) * WARP_AMP_X;
    u.y += -sin(u.x * WARP_FREQ_Y - t + i * 0.02) * WARP_AMP_Y;
    u = fold * u * SHRINK;

    vec2 q = u - vec2(OFFSET_X + breath * 0.1, OFFSET_Y);
    vec2 s = vec2(q.x * ASPECT_X, q.y * ASPECT_Y);
    float glow = GLOW_SIZE / (dot(s, s) + SOFTNESS);
    vec2 e = vec2((q.x - ECHO_SHIFT) * ASPECT_X, s.y);
    glow += ECHO * GLOW_SIZE / (dot(e, e) + SOFTNESS);
    glow *= 0.25 + breath * 0.4;

    float r = length(u);
    float k = sin(i * COLOUR_CYCLE + t * 1.2 + r * HUE_TRAVEL) * 0.5 + 0.5;
    vec3 tint = clamp(oklchToLinear(LIGHTNESS + LIGHT_SWING * k, CHROMA * (0.75 + 0.35 * k), mix(hue0, hue1, k)), 0.0, 1.0);
    color += glow * tint * exp2(-r * FALLOFF);
  }

  vec3 x = max(color, 0.0);
  color = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(0.85, 0.92, 0.98));

  float edge = smoothstep(0.5, 1.6, length(pos));
  color *= 1.0 - edge * VIGNETTE;

  // Acá el shader original cruzaba entre un fondo claro y uno oscuro
  // (uLightMode); no aplica a este uso, así que en vez de eso aplicamos
  // tono + intensidad sobre una base oscura, para que por default sea
  // sutil y no le robe protagonismo a la red (uIntensity bajo).
  vec3 base = vec3(0.035, 0.045, 0.07);
  color = base + color * uTint * uIntensity;

  color += (blueNoise(gl_FragCoord.xy, floor(timeScaled * 24.0)) - 0.5) / 255.0;
  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`

// Conexiones calculadas UNA SOLA VEZ sobre las posiciones finales dentro
// del cerebro (brainTarget), no en cada frame: cada nodo se conecta con sus
// k vecinos más cercanos dentro de una distancia máxima. Devuelve una lista
// plana de pares [i0, j0, i1, j1, ...] (índices de nodos), sin duplicados.
function buildEdges(brainTarget, count, k, maxDistance) {
  const maxDistanceSq = maxDistance * maxDistance
  const edgeSet = new Set()
  const edges = []

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3
    const xi = brainTarget[i3]
    const yi = brainTarget[i3 + 1]
    const zi = brainTarget[i3 + 2]

    // Vecinos más cercanos de i: recorremos todos los demás nodos (el total
    // es chico, 100-600, así que un O(n^2) una sola vez es barato) y nos
    // quedamos con los k más próximos dentro del radio máximo.
    const candidates = []
    for (let j = 0; j < count; j += 1) {
      if (j === i) continue
      const j3 = j * 3
      const dx = brainTarget[j3] - xi
      const dy = brainTarget[j3 + 1] - yi
      const dz = brainTarget[j3 + 2] - zi
      const distSq = dx * dx + dy * dy + dz * dz
      if (distSq <= maxDistanceSq) {
        candidates.push({ j, distSq })
      }
    }
    candidates.sort((a, b) => a.distSq - b.distSq)

    for (let n = 0; n < Math.min(k, candidates.length); n += 1) {
      const j = candidates[n].j
      const key = i < j ? `${i}_${j}` : `${j}_${i}`
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        edges.push(i, j)
      }
    }
  }

  return edges
}

function NeuralNetPreset({ id, values, isPaused, restartToken, staticPreview = false }) {
  const containerRef = useRef(null)
  const valuesRef = useRef(values)
  const isPausedRef = useRef(isPaused)
  const restartTokenRef = useRef(restartToken)

  valuesRef.current = values
  isPausedRef.current = isPaused
  restartTokenRef.current = restartToken

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return undefined
    }
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 30)
    camera.position.set(0, 0, CAMERA_DISTANCE)
    camera.lookAt(0, 0, 0)

    const cloudGroup = new THREE.Group()
    scene.add(cloudGroup)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setClearColor(0x000000, 0)
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
    renderer.setPixelRatio(pixelRatio)
    container.appendChild(renderer.domElement)

    const initialDepthRange = computeDepthRange(
      CAMERA_DISTANCE,
      valuesRef.current.silhouetteScale,
      valuesRef.current.shape
    )
    const nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERTEX_SHADER,
      fragmentShader: POINTS_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSize: { value: valuesRef.current.nodeSize },
        uOpacity: { value: 0.9 },
        uPixelRatio: { value: pixelRatio },
        uColor: { value: hexToVector3(valuesRef.current.nodeColor, new THREE.Vector3()) },
        uDepthNear: { value: initialDepthRange.uDepthNear },
        uDepthFar: { value: initialDepthRange.uDepthFar },
      },
    })

    const lineMaterial = new THREE.ShaderMaterial({
      vertexShader: LINE_VERTEX_SHADER,
      fragmentShader: LINE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: hexToVector3(valuesRef.current.lineColor, new THREE.Vector3()) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uBreatheIntensity: { value: valuesRef.current.lineBreatheIntensity },
        uBreathePeriod: { value: valuesRef.current.lineBreathePeriod },
      },
    })

    // --- "Campo de luz": escena aparte con un quad de pantalla completa
    // (sin atributos, posición derivada de gl_VertexID), renderizada con el
    // mismo renderer antes que la red cuando backgroundType === 'light-field'.
    const lightFieldScene = new THREE.Scene()
    const lightFieldMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: LIGHT_FIELD_VERTEX_SHADER,
      fragmentShader: LIGHT_FIELD_FRAGMENT_SHADER,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        iResolution: { value: new THREE.Vector2(1, 1) },
        iTime: { value: 0 },
        uIntensity: { value: valuesRef.current.lightFieldIntensity },
        uSpeed: { value: valuesRef.current.lightFieldSpeed },
        uTint: { value: hexToVector3(valuesRef.current.lightFieldTint, new THREE.Vector3()) },
      },
    })
    const lightFieldGeometry = new THREE.BufferGeometry()
    // El vertex shader ignora "position" (arma el triángulo a partir de
    // gl_VertexID solo); igual hace falta un atributo position con 3
    // vértices para que three.js calcule bien el draw range (si no, el
    // draw call queda con count=Infinity y no dibuja nada).
    lightFieldGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3))
    const lightFieldMesh = new THREE.Mesh(lightFieldGeometry, lightFieldMaterial)
    lightFieldMesh.frustumCulled = false
    lightFieldScene.add(lightFieldMesh)

    const debugMaterial = new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: 0.035,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })

    const pulseMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.05,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    let particleData = null
    let nodeGeometry = null
    let nodePoints = null
    let debugGeometry = null
    let debugPoints = null
    let lineGeometry = null
    let lineSegments = null
    let linePositions = null
    let edges = []
    let lastNodeCount = null
    let lastShape = null
    let lastK = null
    let lastMaxDistance = null

    // Un objeto por "slot" de pulso: qué arista recorre y en qué momento de
    // ese recorrido va (0..1). Se reasigna a una arista nueva al azar cada
    // vez que termina un ciclo.
    const pulseGeometry = new THREE.BufferGeometry()
    const pulsePositions = new Float32Array(PULSE_COUNT * 3)
    pulseGeometry.setAttribute('position', new THREE.BufferAttribute(pulsePositions, 3))
    const pulsePoints = new THREE.Points(pulseGeometry, pulseMaterial)
    cloudGroup.add(pulsePoints)
    const pulses = Array.from({ length: PULSE_COUNT }, () => ({
      edgeIndex: -1,
      t: Math.random(),
      duration: PULSE_DURATION_SECONDS * (0.8 + Math.random() * 0.4),
    }))

    const morphClock = createMorphClock()
    let breathePhase = 0
    let lastRestartToken = restartTokenRef.current

    function rebuildNodes(count, shape) {
      if (nodePoints) {
        cloudGroup.remove(nodePoints)
        nodeGeometry.dispose()
        cloudGroup.remove(debugPoints)
        debugGeometry.dispose()
      }
      // mode='structure': en poliedros, los nodos se agrupan cerca de los
      // vértices reales (no superficie uniforme) para que las líneas k-NN
      // tracen la estructura del sólido en vez de una nube sin forma.
      particleData = buildMorphParticleData(count, shape, 'structure')
      nodeGeometry = new THREE.BufferGeometry()
      nodeGeometry.setAttribute('position', new THREE.BufferAttribute(particleData.position, 3))
      nodeGeometry.setAttribute('aRandom', new THREE.BufferAttribute(particleData.random, 3))
      nodePoints = new THREE.Points(nodeGeometry, nodeMaterial)
      cloudGroup.add(nodePoints)

      debugGeometry = new THREE.BufferGeometry()
      debugGeometry.setAttribute('position', new THREE.BufferAttribute(particleData.brainTarget, 3))
      debugPoints = new THREE.Points(debugGeometry, debugMaterial)
      debugPoints.visible = false
      cloudGroup.add(debugPoints)

      lastNodeCount = count
      lastShape = shape
      morphClock.reset()
    }

    function rebuildEdges(k, maxDistance) {
      if (lineSegments) {
        cloudGroup.remove(lineSegments)
        lineGeometry.dispose()
      }
      edges = buildEdges(particleData.brainTarget, particleData.position.length / 3, k, maxDistance)
      const edgeCount = edges.length / 2
      linePositions = new Float32Array(edges.length * 3)
      // Una fase al azar por arista (misma en los dos extremos, para que la
      // línea entera respire junta) — "Respiración de líneas".
      const linePhases = new Float32Array(edges.length)
      for (let e = 0; e < edgeCount; e += 1) {
        const phase = Math.random() * Math.PI * 2
        linePhases[e * 2] = phase
        linePhases[e * 2 + 1] = phase
      }
      lineGeometry = new THREE.BufferGeometry()
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3))
      lineGeometry.setAttribute('aPhase', new THREE.BufferAttribute(linePhases, 1))
      lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial)
      cloudGroup.add(lineSegments)
      lastK = k
      lastMaxDistance = maxDistance
      // Las aristas cambiaron: los pulsos en curso ya no apuntan a índices
      // válidos de forma confiable, los reseteamos.
      pulses.forEach((pulse) => {
        pulse.edgeIndex = -1
        pulse.t = Math.random()
      })
    }

    rebuildNodes(valuesRef.current.nodeCount, valuesRef.current.shape)
    rebuildEdges(valuesRef.current.neighborsK, valuesRef.current.maxConnectionDistance)

    // Con movimiento reducido, mostrar la figura terminada sin
    // arrancar la simulación. El playground conserva su comportamiento normal.
    function settleStaticPreview() {
      if (!staticPreview) return
      computeMorphTargets(
        particleData,
        1,
        0,
        valuesRef.current.silhouetteScale,
        valuesRef.current.morphMax
      )
      particleData.position.set(particleData.target)
      nodeGeometry.attributes.position.needsUpdate = true
      updateLinePositions()
    }
    settleStaticPreview()

    // La máscara real (/public/masks/brain.svg) carga de forma asíncrona;
    // mientras tanto ya estamos usando el fallback procedural. Cuando
    // resuelve, regeneramos brainTarget con la máscara y recalculamos las
    // conexiones sobre esas posiciones nuevas (dependen de brainTarget).
    // Solo aplica a la forma "Cerebro": los poliedros no usan máscara.
    let disposed = false
    loadBrainMaskSampler().then((sampler) => {
      if (disposed || !sampler || valuesRef.current.shape !== 'brain') return
      regenerateBrainTargets(particleData, 'brain', 'structure')
      rebuildEdges(valuesRef.current.neighborsK, valuesRef.current.maxConnectionDistance)
      settleStaticPreview()
    })

    // --- Fondo por efecto (ver StardustPreset para la explicación larga):
    // "Ninguno" deja scene.background en null, "Color sólido"/"Degradado"
    // lo pintan acá.
    let gradientTexture = null
    let lastBackgroundType = null
    let lastBackgroundColorA = null
    let lastBackgroundColorB = null
    function applyBackground() {
      const { backgroundType, backgroundColorA, backgroundColorB } = valuesRef.current
      if (
        backgroundType === lastBackgroundType &&
        backgroundColorA === lastBackgroundColorA &&
        backgroundColorB === lastBackgroundColorB
      ) {
        return
      }
      if (backgroundType === 'solid') {
        scene.background = new THREE.Color(backgroundColorA)
      } else if (backgroundType === 'gradient') {
        gradientTexture?.dispose()
        gradientTexture = createGradientBackgroundTexture(backgroundColorA, backgroundColorB)
        scene.background = gradientTexture
      } else {
        scene.background = null
      }
      lastBackgroundType = backgroundType
      lastBackgroundColorA = backgroundColorA
      lastBackgroundColorB = backgroundColorB
    }
    applyBackground()

    // --- Estrellas de fondo: capa fija (no rota con cloudGroup).
    let starField = createStarField(valuesRef.current.starDensity, pixelRatio)
    scene.add(starField)
    let lastStarDensity = valuesRef.current.starDensity

    function resize() {
      const width = container.clientWidth || 1
      const height = container.clientHeight || 1
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }
    resize()

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)

    let isIntersecting = true
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        isIntersecting = entries[0]?.isIntersecting ?? true
      },
      { threshold: 0 }
    )
    intersectionObserver.observe(container)

    let isPageVisible = document.visibilityState === 'visible'
    const handleVisibilityChange = () => {
      isPageVisible = document.visibilityState === 'visible'
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Recalcula las posiciones de los extremos de cada línea a partir de las
    // posiciones YA simuladas de los nodos (siguen el morph en vivo).
    function updateLinePositions() {
      const { position } = particleData
      for (let e = 0; e < edges.length / 2; e += 1) {
        const i = edges[e * 2]
        const j = edges[e * 2 + 1]
        const e6 = e * 6
        const i3 = i * 3
        const j3 = j * 3
        linePositions[e6] = position[i3]
        linePositions[e6 + 1] = position[i3 + 1]
        linePositions[e6 + 2] = position[i3 + 2]
        linePositions[e6 + 3] = position[j3]
        linePositions[e6 + 4] = position[j3 + 1]
        linePositions[e6 + 5] = position[j3 + 2]
      }
      lineGeometry.attributes.position.needsUpdate = true
    }

    function updatePulses(dt) {
      const edgeCount = edges.length / 2
      const { position } = particleData
      if (!valuesRef.current.pulses || edgeCount === 0) {
        pulseMaterial.opacity = 0
        return
      }
      pulseMaterial.opacity = 0.8

      for (let p = 0; p < pulses.length; p += 1) {
        const pulse = pulses[p]
        if (pulse.edgeIndex === -1) {
          pulse.edgeIndex = Math.floor(Math.random() * edgeCount)
        }
        pulse.t += dt / pulse.duration
        if (pulse.t >= 1) {
          pulse.t = 0
          pulse.duration = PULSE_DURATION_SECONDS * (0.8 + Math.random() * 0.4)
          pulse.edgeIndex = Math.floor(Math.random() * edgeCount)
        }

        const i = edges[pulse.edgeIndex * 2]
        const j = edges[pulse.edgeIndex * 2 + 1]
        const i3 = i * 3
        const j3 = j * 3
        const p3 = p * 3
        pulsePositions[p3] = position[i3] + (position[j3] - position[i3]) * pulse.t
        pulsePositions[p3 + 1] = position[i3 + 1] + (position[j3 + 1] - position[i3 + 1]) * pulse.t
        pulsePositions[p3 + 2] = position[i3 + 2] + (position[j3 + 2] - position[i3 + 2]) * pulse.t
      }
      pulseGeometry.attributes.position.needsUpdate = true
    }

    let rafId = null
    let lastTimestamp = performance.now()
    let elapsed = 0

    function renderFrame(timestamp) {
      rafId = requestAnimationFrame(renderFrame)

      if (!isIntersecting || !isPageVisible) {
        return
      }

      const rawDt = (timestamp - lastTimestamp) / 1000
      lastTimestamp = timestamp
      const dt = Math.min(rawDt, MAX_DELTA_SECONDS)

      if (valuesRef.current.nodeCount !== lastNodeCount || valuesRef.current.shape !== lastShape) {
        rebuildNodes(valuesRef.current.nodeCount, valuesRef.current.shape)
        rebuildEdges(valuesRef.current.neighborsK, valuesRef.current.maxConnectionDistance)
      } else if (
        valuesRef.current.neighborsK !== lastK ||
        valuesRef.current.maxConnectionDistance !== lastMaxDistance
      ) {
        rebuildEdges(valuesRef.current.neighborsK, valuesRef.current.maxConnectionDistance)
      }
      if (restartTokenRef.current !== lastRestartToken) {
        lastRestartToken = restartTokenRef.current
        morphClock.restart()
      }
      if (valuesRef.current.starDensity !== lastStarDensity) {
        scene.remove(starField)
        starField.geometry.dispose()
        starField.material.dispose()
        starField = createStarField(valuesRef.current.starDensity, pixelRatio)
        scene.add(starField)
        lastStarDensity = valuesRef.current.starDensity
      }
      // Si está en pausa avanzamos el reloj con dt=0: sigue resolviendo
      // auto/manual (para que la opacidad de líneas use el progreso
      // correcto) pero sin mover la máquina de estados.
      const globalProgress = staticPreview
        ? 1
        : morphClock.resolveProgress(
            isPausedRef.current ? 0 : dt,
            valuesRef.current.morphProgress,
            valuesRef.current.loop,
            valuesRef.current.morphMax,
            valuesRef.current.cycleDuration,
            valuesRef.current.morphMin
          )

      if (!isPausedRef.current) {
        elapsed += dt
        breathePhase += dt * 0.55
        computeMorphTargets(
          particleData,
          globalProgress,
          breathePhase,
          valuesRef.current.silhouetteScale,
          valuesRef.current.morphMax
        )
        // Neural Net no expone "Fuerza del ruido" en el panel (no está en el
        // spec para este efecto): usamos un valor fijo y moderado, suficiente
        // para que se note "vivo" sin deshacer la red de conexiones.
        stepMorphPhysics(particleData, dt, elapsed, {
          speed: valuesRef.current.speed,
          noiseStrength: 0.3,
          cursor: null,
        })
        nodeGeometry.attributes.position.needsUpdate = true
        updateLinePositions()
        updatePulses(dt)
        cloudGroup.rotation.y += ROTATION_SPEED_Y * dt
        cloudGroup.rotation.x += ROTATION_SPEED_X * dt
      }

      nodeMaterial.uniforms.uSize.value = valuesRef.current.nodeSize
      hexToVector3(valuesRef.current.nodeColor, nodeMaterial.uniforms.uColor.value)
      const depthRange = computeDepthRange(
        CAMERA_DISTANCE,
        valuesRef.current.silhouetteScale,
        valuesRef.current.shape
      )
      nodeMaterial.uniforms.uDepthNear.value = depthRange.uDepthNear
      nodeMaterial.uniforms.uDepthFar.value = depthRange.uDepthFar
      hexToVector3(valuesRef.current.lineColor, lineMaterial.uniforms.uColor.value)
      // "En Scatter casi no hay líneas; conforme avanza Converge, las
      // líneas aparecen con fade-in": opacidad de las líneas atada al
      // progreso global del morph. La "respiración" (oscilación lenta con
      // fase por línea) se suma encima en el fragment shader.
      lineMaterial.uniforms.uOpacity.value = valuesRef.current.lineOpacity * globalProgress
      lineMaterial.uniforms.uTime.value = elapsed
      lineMaterial.uniforms.uBreatheIntensity.value = valuesRef.current.lineBreatheIntensity
      lineMaterial.uniforms.uBreathePeriod.value = valuesRef.current.lineBreathePeriod

      starField.visible = Boolean(valuesRef.current.showStars)
      starField.material.uniforms.uTime.value = elapsed
      starField.material.uniforms.uBrightness.value = valuesRef.current.starBrightness

      const showDebugTarget = Boolean(valuesRef.current.debugShowTarget)
      nodePoints.visible = !showDebugTarget
      lineSegments.visible = !showDebugTarget
      pulsePoints.visible = !showDebugTarget
      debugPoints.visible = showDebugTarget

      if (valuesRef.current.backgroundType === 'light-field') {
        // Quad de pantalla completa dibujado con el mismo renderer, antes
        // que la red: por eso autoClear se apaga a mano (si no, el segundo
        // render call borraría lo que acabamos de pintar acá).
        scene.background = null
        lightFieldMaterial.uniforms.iTime.value = elapsed
        lightFieldMaterial.uniforms.iResolution.value.set(
          renderer.domElement.width,
          renderer.domElement.height
        )
        const breathAmplitude = Math.min(
          1,
          Math.max(0, valuesRef.current.lightFieldBreathAmplitude ?? 0)
        )
        const breathPeriod = Math.min(
          30,
          Math.max(4, valuesRef.current.lightFieldBreathPeriod ?? 12)
        )
        const breathFactor =
          reducedMotionQuery.matches || isPausedRef.current || staticPreview
            ? 1
            : getLightFieldBreathFactor(elapsed, breathAmplitude, breathPeriod)
        lightFieldMaterial.uniforms.uIntensity.value =
          valuesRef.current.lightFieldIntensity * breathFactor
        lightFieldMaterial.uniforms.uSpeed.value = valuesRef.current.lightFieldSpeed
        hexToVector3(valuesRef.current.lightFieldTint, lightFieldMaterial.uniforms.uTint.value)
        renderer.autoClear = false
        renderer.clear()
        renderer.render(lightFieldScene, camera)
      } else {
        renderer.autoClear = true
        applyBackground()
      }

      renderer.render(scene, camera)
    }
    rafId = requestAnimationFrame(renderFrame)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      nodeGeometry?.dispose()
      debugGeometry?.dispose()
      lineGeometry?.dispose()
      pulseGeometry.dispose()
      nodeMaterial.dispose()
      lineMaterial.dispose()
      debugMaterial.dispose()
      pulseMaterial.dispose()
      starField.geometry.dispose()
      starField.material.dispose()
      gradientTexture?.dispose()
      lightFieldGeometry.dispose()
      lightFieldMaterial.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={containerRef} id={id} className="shader-lab__shader" />
}

export default NeuralNetPreset
