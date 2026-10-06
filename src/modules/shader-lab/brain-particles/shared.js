import * as THREE from 'three'
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js'

// Utilidades compartidas entre los efectos "Stardust" (A) y "Neural Net" (B)
// del SPEC de brain-particles: la silueta del cerebro, la máquina de estados
// del morph y la física de la simulación son las mismas para los dos; cada
// efecto solo cambia cómo se dibuja (polvo vs. nodos+líneas).

export const MAX_PIXEL_RATIO = 2
export const MAX_DELTA_SECONDS = 0.05

// --- Silueta procedural del cerebro (fallback: todavía no leemos una
// máscara de imagen, eso es trabajo de la Fase 4). Vista lateral simple: un
// lóbulo principal en forma de "huevo" (más ancho arriba que abajo) más un
// lóbulo chico abajo-atrás para el cerebelo. +x = frente, -x = atrás.
//
// Punto de extensión a futuro (sin implementar todavía): cuando haya un
// modelo 3D .glb del cerebro, este muestreo se podría reemplazar por
// THREE.MeshSurfaceSampler sobre su geometría, manteniendo la misma firma
// (recibe cuántos puntos hacen falta, devuelve posiciones x/y/z).
const BRAIN_MAIN_RADIUS_X = 0.6
const BRAIN_MAIN_RADIUS_Y_TOP = 0.52
const BRAIN_MAIN_RADIUS_Y_BOTTOM = 0.4
const BRAIN_CEREBELLUM_CENTER_X = -0.42
const BRAIN_CEREBELLUM_CENTER_Y = -0.34
const BRAIN_CEREBELLUM_RADIUS_X = 0.22
const BRAIN_CEREBELLUM_RADIUS_Y = 0.18
const BRAIN_SAMPLE_BOUNDS_X = 0.85
const BRAIN_SAMPLE_BOUNDS_Y = 0.68
const BRAIN_DEPTH_JITTER = 0.12
// Fracción de partículas/nodos que preferimos ubicar cerca del contorno en
// vez de repartidos parejo por todo el interior: "muestrear más denso en los
// bordes para que la silueta se lea bien", como pide el spec.
const BRAIN_EDGE_BIAS_RATIO = 0.35

// Semiancho/alto aproximado de la silueta, usado también para calibrar el
// rango de profundidad del shader de partículas.
export const BRAIN_HALF_EXTENT = 0.66
// Radio donde arrancan dispersas las partículas/nodos (el "caos" inicial).
// Suficientemente grande para cubrir todo el canvas (incluso el ancho, más
// generoso que el alto) y salirse de los bordes en Scatter, nunca
// concentrarse en el centro.
export const SCATTER_RADIUS = 3.2

export const SHAPE_OPTIONS = [
  { value: 'brain', label: 'Cerebro' },
  { value: 'octahedron', label: 'Octaedro' },
  { value: 'dodecahedron', label: 'Dodecaedro' },
  { value: 'icosahedron', label: 'Icosaedro' },
]

// Semiextensión (sin escalar) de cada forma, para calibrar uDepthNear según
// cuál esté seleccionada. Los poliedros están normalizados a radio 1.
const SHAPE_HALF_EXTENT = {
  brain: BRAIN_HALF_EXTENT,
  octahedron: 1,
  dodecahedron: 1,
  icosahedron: 1,
}

// Rango de profundidad (en unidades de mundo, distancia a la cámara) para
// uDepthNear/uDepthFar del shader de puntos. Depende de `scale` porque
// "Escala de silueta" cambia el tamaño real de la forma en vivo, y de
// `shape` porque cada forma tiene una extensión base distinta.
export function computeDepthRange(cameraDistance, scale, shape = 'brain') {
  const halfExtent = SHAPE_HALF_EXTENT[shape] ?? BRAIN_HALF_EXTENT
  return {
    uDepthFar: cameraDistance + SCATTER_RADIUS,
    uDepthNear: cameraDistance - halfExtent * scale,
  }
}

function isInsideBrainSilhouette(x, y) {
  const ny = y >= 0 ? y / BRAIN_MAIN_RADIUS_Y_TOP : y / BRAIN_MAIN_RADIUS_Y_BOTTOM
  const nx = x / BRAIN_MAIN_RADIUS_X
  if (nx * nx + ny * ny <= 1) return true

  const cx = (x - BRAIN_CEREBELLUM_CENTER_X) / BRAIN_CEREBELLUM_RADIUS_X
  const cy = (y - BRAIN_CEREBELLUM_CENTER_Y) / BRAIN_CEREBELLUM_RADIUS_Y
  return cx * cx + cy * cy <= 1
}

// Rechazo por muestreo: tiramos puntos al azar dentro de una caja y nos
// quedamos con los que caen adentro de la silueta. Para el sesgo de borde,
// además pedimos que el mismo punto "empujado" un poco hacia afuera del
// centro ya no esté adentro (o sea, que esté cerca del contorno).
function sampleProceduralPoint(preferEdge) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const x = (Math.random() * 2 - 1) * BRAIN_SAMPLE_BOUNDS_X
    const y = (Math.random() * 2 - 1) * BRAIN_SAMPLE_BOUNDS_Y
    if (!isInsideBrainSilhouette(x, y)) continue
    if (!preferEdge) return { x, y }
    if (!isInsideBrainSilhouette(x * 1.12, y * 1.12)) {
      return { x, y }
    }
  }
  // No encontramos un punto de borde en los intentos: cualquier punto
  // interior sirve, para no trabarnos generando miles de partículas.
  return sampleProceduralPoint(false)
}

// --- Formas alternativas (Fase "Forma"): poliedros regulares de three.js,
// además del cerebro. Para Stardust muestreamos su SUPERFICIE con
// MeshSurfaceSampler (polvo cubriendo el sólido); para Neural Net agrupamos
// los nodos cerca de sus VÉRTICES reales (calculados a mano, son constantes
// matemáticas conocidas) para que las conexiones k-NN calcadas entre
// vértices cercanos tracen la estructura real del sólido.
const POLYHEDRON_GEOMETRY_BUILDERS = {
  octahedron: () => new THREE.OctahedronGeometry(1, 0),
  dodecahedron: () => new THREE.DodecahedronGeometry(1, 0),
  icosahedron: () => new THREE.IcosahedronGeometry(1, 0),
}

const shapeSamplerCache = new Map()
function getPolyhedronSurfaceSampler(shape) {
  if (!shapeSamplerCache.has(shape)) {
    const geometry = POLYHEDRON_GEOMETRY_BUILDERS[shape]()
    const sampler = new MeshSurfaceSampler(new THREE.Mesh(geometry)).build()
    shapeSamplerCache.set(shape, sampler)
  }
  return shapeSamplerCache.get(shape)
}

const _shapeSamplePoint = new THREE.Vector3()
function samplePolyhedronSurfacePoint(shape) {
  getPolyhedronSurfaceSampler(shape).sample(_shapeSamplePoint)
  return { x: _shapeSamplePoint.x, y: _shapeSamplePoint.y, z: _shapeSamplePoint.z }
}

const PHI = (1 + Math.sqrt(5)) / 2
function normalizedVertices(list) {
  return list.map(([x, y, z]) => {
    const len = Math.sqrt(x * x + y * y + z * z)
    return [x / len, y / len, z / len]
  })
}
// Vértices únicos (radio 1), coordenadas clásicas de cada sólido platónico.
const POLYHEDRON_VERTICES = {
  octahedron: normalizedVertices([
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]),
  icosahedron: normalizedVertices([
    [0, 1, PHI],
    [0, 1, -PHI],
    [0, -1, PHI],
    [0, -1, -PHI],
    [1, PHI, 0],
    [1, -PHI, 0],
    [-1, PHI, 0],
    [-1, -PHI, 0],
    [PHI, 0, 1],
    [PHI, 0, -1],
    [-PHI, 0, 1],
    [-PHI, 0, -1],
  ]),
  dodecahedron: normalizedVertices([
    [1, 1, 1],
    [1, 1, -1],
    [1, -1, 1],
    [1, -1, -1],
    [-1, 1, 1],
    [-1, 1, -1],
    [-1, -1, 1],
    [-1, -1, -1],
    [0, 1 / PHI, PHI],
    [0, 1 / PHI, -PHI],
    [0, -1 / PHI, PHI],
    [0, -1 / PHI, -PHI],
    [1 / PHI, PHI, 0],
    [1 / PHI, -PHI, 0],
    [-1 / PHI, PHI, 0],
    [-1 / PHI, -PHI, 0],
    [PHI, 0, 1 / PHI],
    [PHI, 0, -1 / PHI],
    [-PHI, 0, 1 / PHI],
    [-PHI, 0, -1 / PHI],
  ]),
}
// Cuánto se dispersan los nodos alrededor de cada vértice: chico, para que
// se lean como "esquinas" puntuales y no como una nube difusa.
const STRUCTURE_VERTEX_JITTER = 0.06

function sampleVertexClusterPoint(shape) {
  const vertices = POLYHEDRON_VERTICES[shape]
  const [vx, vy, vz] = vertices[(Math.random() * vertices.length) | 0]
  return {
    x: vx + (Math.random() * 2 - 1) * STRUCTURE_VERTEX_JITTER,
    y: vy + (Math.random() * 2 - 1) * STRUCTURE_VERTEX_JITTER,
    z: vz + (Math.random() * 2 - 1) * STRUCTURE_VERTEX_JITTER,
  }
}

// Punto único de entrada que usan buildMorphParticleData/regenerateBrainTargets
// para decidir, según la forma elegida, de dónde sacar cada punto objetivo.
// shape='brain' sigue usando la máscara/fallback procedural (2D + jitter de
// profundidad); los poliedros devuelven un punto 3D real ya con volumen.
function sampleShapeTargetPoint(shape, mode) {
  if (shape === 'brain' || !shape) {
    const preferEdge = Math.random() < BRAIN_EDGE_BIAS_RATIO
    const point = getCurrentBrainSampler()(preferEdge)
    return { x: point.x, y: point.y, z: gaussianRandom() * BRAIN_DEPTH_JITTER }
  }
  if (mode === 'structure') {
    return sampleVertexClusterPoint(shape)
  }
  return samplePolyhedronSurfacePoint(shape)
}

// --- Máscara real (/public/masks/brain.svg), la "opción principal" del
// spec: la leemos con un canvas 2D y tomamos puntos donde el alpha > 0.5.
// El fallback procedural de arriba sigue siendo lo que se usa mientras la
// máscara carga (o si falla), así el efecto funciona desde el primer
// momento sin esperar una imagen.
const MASK_URL = '/masks/brain.svg'
const MASK_SAMPLE_SIZE = 256
// Mismo bound que usamos para generar el contorno de brain.svg: mapea nuestro
// espacio local (-MASK_SAMPLE_BOUND..MASK_SAMPLE_BOUND) al canvas 0..256.
const MASK_SAMPLE_BOUND = 0.85
let maskSamplerPromise = null
let resolvedMaskSampler = null

function buildMaskSampler(imageData, size) {
  const data = imageData.data
  function alphaAt(px, py) {
    const x = Math.max(0, Math.min(size - 1, px | 0))
    const y = Math.max(0, Math.min(size - 1, py | 0))
    return data[(y * size + x) * 4 + 3]
  }
  function isInsideMask(x, y) {
    const px = ((x / MASK_SAMPLE_BOUND + 1) * 0.5) * size
    // Y invertido: +y en nuestro espacio local es "arriba", el canvas crece
    // hacia abajo.
    const py = (1 - (y / MASK_SAMPLE_BOUND + 1) * 0.5) * size
    return alphaAt(px, py) > 128
  }
  return function sampleMaskPoint(preferEdge) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const x = (Math.random() * 2 - 1) * MASK_SAMPLE_BOUND
      const y = (Math.random() * 2 - 1) * MASK_SAMPLE_BOUND
      if (!isInsideMask(x, y)) continue
      if (!preferEdge) return { x, y }
      if (!isInsideMask(x * 1.12, y * 1.12)) return { x, y }
    }
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const x = (Math.random() * 2 - 1) * MASK_SAMPLE_BOUND
      const y = (Math.random() * 2 - 1) * MASK_SAMPLE_BOUND
      if (isInsideMask(x, y)) return { x, y }
    }
    return { x: 0, y: 0 }
  }
}

// Dispara (una sola vez, cacheado a nivel de módulo) la carga de la máscara.
// Todas las instancias de Stardust/Neural Net comparten esta misma promesa,
// así no se decodifica la imagen por separado para cada preview.
export function loadBrainMaskSampler() {
  if (!maskSamplerPromise) {
    maskSamplerPromise = new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve(null)
        return
      }
      const image = new Image()
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = MASK_SAMPLE_SIZE
          canvas.height = MASK_SAMPLE_SIZE
          const ctx = canvas.getContext('2d')
          ctx.clearRect(0, 0, MASK_SAMPLE_SIZE, MASK_SAMPLE_SIZE)
          ctx.drawImage(image, 0, 0, MASK_SAMPLE_SIZE, MASK_SAMPLE_SIZE)
          const imageData = ctx.getImageData(0, 0, MASK_SAMPLE_SIZE, MASK_SAMPLE_SIZE)
          resolve(buildMaskSampler(imageData, MASK_SAMPLE_SIZE))
        } catch {
          // Falla típica: CORS/lienzo "tainted". Nos quedamos con el
          // fallback procedural en vez de romper el efecto.
          resolve(null)
        }
      }
      image.onerror = () => resolve(null)
      image.src = MASK_URL
    }).then((sampler) => {
      resolvedMaskSampler = sampler
      return sampler
    })
  }
  return maskSamplerPromise
}

// Sampler que `buildMorphParticleData`/`regenerateBrainTargets` usan: la
// máscara si ya cargó, si no el fallback procedural (nunca null).
function getCurrentBrainSampler() {
  return resolvedMaskSampler || sampleProceduralPoint
}

// Vuelve a ubicar solo brainTarget (no toca scatterHome/position/velocity)
// con el sampler que esté disponible en este momento. Se llama una vez que
// `loadBrainMaskSampler()` resuelve, para "actualizar" partículas que ya se
// generaron con el fallback procedural mientras la máscara cargaba.
export function regenerateBrainTargets(particleData, shape = 'brain', mode = 'surface') {
  const { brainTarget, convergeDelay } = particleData
  const count = convergeDelay.length
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3
    const point = sampleShapeTargetPoint(shape, mode)
    brainTarget[i3] = point.x
    brainTarget[i3 + 1] = point.y
    brainTarget[i3 + 2] = point.z
  }
}

// Gaussiana estándar vía Box-Muller: valores que se concentran cerca de 0 y
// se diluyen hacia afuera. La usamos para el jitter de profundidad de la
// silueta (le da volumen en vez de verse un cartón plano).
function gaussianRandom() {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function randomInSphere(radius) {
  // Punto uniforme dentro de una esfera: dirección al azar + radio con raíz
  // cúbica (si no, los puntos se amontonan cerca del centro).
  const direction = new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1
  )
  if (direction.lengthSq() === 0) direction.set(1, 0, 0)
  direction.normalize()
  const r = radius * Math.cbrt(Math.random())
  return direction.multiplyScalar(r)
}

// --- Máquina de estados del morph ---
// Cuánto puede "esperar" antes de arrancar la partícula/nodo más tardío de
// Converge (como fracción de la duración total): da el efecto de que no
// todos llegan al mismo tiempo, como pide el spec.
const CONVERGE_DELAY_SPREAD = 0.4
// Amplitud/velocidad de la "respiración" chica (jitter) en Settle, además
// del vaivén 0->máximo->0 del reloj: un pulso lento y sutil adicional para
// que la forma nunca se vea completamente estática.
const BREATHE_AMPLITUDE = 0.035
const BREATHE_SPEED = 0.55

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

// Reloj de la máquina de estados, encapsulado para que cada efecto (A, B)
// tenga el suyo sin pisarse.
//
// Con Loop activo: ida y vuelta continua 0 -> morphMax -> 0, sin pausas ni
// saltos — cada tramo (ida, vuelta) dura `cycleDuration` segundos y usa
// easeInOutCubic, que ya llega con velocidad ~0 a cada extremo, así el
// cambio de dirección se siente como una respiración, no un rebote.
// Sin Loop: sube una sola vez de 0 a morphMax en `cycleDuration` segundos y
// se queda ahí (sin volver a dispersarse).
//
// `resolveProgress` es lo único que el loop de render necesita llamar cada
// frame: decide solo si el ciclo lo maneja el reloj automático o si el
// usuario está scrubeando manualmente el control "Progreso de morph" (se
// activa la primera vez que ese valor cambia respecto al frame anterior;
// el slider manual sigue pudiendo llegar a 1, sin el tope de morphMax).
export function createMorphClock() {
  let elapsedInLeg = 0
  let direction = 1
  let morphProgress = 0
  let manualActive = false
  let lastSeenManualValue = null

  function advanceAuto(dt, loopEnabled, morphMin, morphMax, cycleDuration) {
    const duration = Math.max(cycleDuration, 0.001)
    if (!loopEnabled) {
      elapsedInLeg = Math.min(elapsedInLeg + dt, duration)
    } else {
      elapsedInLeg += dt * direction
      if (elapsedInLeg >= duration) {
        elapsedInLeg = duration
        direction = -1
      } else if (elapsedInLeg <= 0) {
        elapsedInLeg = 0
        direction = 1
      }
    }
    const t = elapsedInLeg / duration
    // morphMin=0 (default) reproduce exactamente el comportamiento de
    // antes (0 -> morphMax -> 0); con morphMin>0 el ciclo oscila entre los
    // dos sin pasar nunca por debajo del piso.
    morphProgress = morphMin + easeInOutCubic(t) * (morphMax - morphMin)
    return morphProgress
  }

  return {
    // Se usa cuando cambian partículas/forma (hay que regenerar la
    // geometría igual): solo reinicia el tramo del ciclo, no toca si el
    // usuario está en modo manual (si estaba scrubeando el slider, sigue
    // scrubeando después del rebuild).
    reset() {
      elapsedInLeg = 0
      direction = 1
      morphProgress = 0
    },
    // Botón "Reiniciar loop": además de reiniciar el tramo, sale del modo
    // manual (por si el usuario había movido "Progreso de morph" a mano)
    // para volver a ver el ciclo automático completo desde el principio.
    restart() {
      elapsedInLeg = 0
      direction = 1
      morphProgress = 0
      manualActive = false
      lastSeenManualValue = null
    },
    // manualValue: el valor actual del control "Progreso de morph".
    // morphMin: 0 si el efecto no tiene ese control (p.ej. Stardust, que
    // sigue yendo de disperso a morphMax como siempre).
    resolveProgress(dt, manualValue, loopEnabled, morphMax, cycleDuration, morphMin = 0) {
      if (lastSeenManualValue === null) lastSeenManualValue = manualValue
      if (manualValue !== lastSeenManualValue) {
        manualActive = true
        lastSeenManualValue = manualValue
      }
      return manualActive
        ? manualValue
        : advanceAuto(dt, loopEnabled, morphMin, morphMax, cycleDuration)
    },
  }
}

// --- Datos de partículas/nodos para el morph ---
// scatterHome: punto "de origen" al que vuelve cada partícula en Scatter (y
// al reiniciar el loop). brainTarget: su lugar fijo dentro de la silueta una
// vez termina Converge. target: lo que la simulación persigue cada frame
// (lo recalcula computeMorphTargets mezclando los dos anteriores).
export function buildMorphParticleData(count, shape = 'brain', mode = 'surface') {
  const position = new Float32Array(count * 3)
  const velocity = new Float32Array(count * 3)
  const scatterHome = new Float32Array(count * 3)
  const brainTarget = new Float32Array(count * 3)
  const target = new Float32Array(count * 3)
  const random = new Float32Array(count * 3)
  const convergeDelay = new Float32Array(count)
  // Progreso individual ya "easeado" (0 = todavía en scatterHome, 1 =
  // asentada del todo en su target): lo llena computeMorphTargets y lo usa
  // stepMorphPhysics para atenuar ruido/ablandar o endurecer el resorte.
  const morphEased = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3
    const scatter = randomInSphere(SCATTER_RADIUS)
    scatterHome[i3] = scatter.x
    scatterHome[i3 + 1] = scatter.y
    scatterHome[i3 + 2] = scatter.z
    position[i3] = scatter.x
    position[i3 + 1] = scatter.y
    position[i3 + 2] = scatter.z
    target[i3] = scatter.x
    target[i3 + 1] = scatter.y
    target[i3 + 2] = scatter.z

    const shapePoint = sampleShapeTargetPoint(shape, mode)
    brainTarget[i3] = shapePoint.x
    brainTarget[i3 + 1] = shapePoint.y
    brainTarget[i3 + 2] = shapePoint.z

    random[i3] = Math.random()
    random[i3 + 1] = Math.random()
    random[i3 + 2] = Math.random()
    convergeDelay[i] = Math.random() * CONVERGE_DELAY_SPREAD
  }

  return { position, velocity, scatterHome, brainTarget, target, random, convergeDelay, morphEased }
}

// Recalcula, para cada partícula/nodo, el punto que la simulación debe
// perseguir este frame: mezcla de scatterHome -> brainTarget (escalado por
// `scale`, el control "Escala de silueta") según el progreso global del
// morph, con el retraso/aceleración individual (convergeDelay) y un easing
// suave. Cerca del tope (Settle) le suma además un pulso lento de
// "respiración" para que la forma nunca se vea congelada.
//
// `morphMax` es el tope del ciclo automático ("Morph máximo"): normalizamos
// el progreso contra ese tope (no contra 1 fijo) para que el escalonado por
// partícula (convergeDelay) siga llegando a "completamente asentado" justo
// cuando el reloj toca su punto más alto, sin importar qué tan bajo sea el
// tope. El slider manual sí puede pasarse de morphMax (llega hasta 1): ahí
// simplemente se queda clampeado en "totalmente asentado".
export function computeMorphTargets(particleData, globalProgress, breathePhase, scale = 1, morphMax = 1) {
  const { scatterHome, brainTarget, target, convergeDelay, morphEased } = particleData
  const count = convergeDelay.length
  const normalizedProgress = Math.min(globalProgress / Math.max(morphMax, 0.001), 1)
  const breathe = (1 + BREATHE_AMPLITUDE * Math.sin(breathePhase) * normalizedProgress) * scale

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3
    const localT = (normalizedProgress - convergeDelay[i]) / (1 - convergeDelay[i])
    const eased = easeInOutCubic(Math.min(Math.max(localT, 0), 1))
    morphEased[i] = eased

    target[i3] = scatterHome[i3] + (brainTarget[i3] * breathe - scatterHome[i3]) * eased
    target[i3 + 1] = scatterHome[i3 + 1] + (brainTarget[i3 + 1] * breathe - scatterHome[i3 + 1]) * eased
    target[i3 + 2] = scatterHome[i3 + 2] + (brainTarget[i3 + 2] * breathe - scatterHome[i3 + 2]) * eased
  }
}

// --- Ruido y física compartidos ---

// Aproximación barata de "curl noise": en vez de un simplex noise 3D real
// (caro de evaluar miles de veces por frame en CPU), sumamos senos/cosenos
// en ejes cruzados. No es matemáticamente un campo sin divergencia, pero da
// el mismo look de corriente/remolino orgánico a una fracción del costo.
const curlScratch = { x: 0, y: 0, z: 0 }
function curlLikeInto(out, x, y, z, t) {
  const fx = x * 1.3
  const fy = y * 1.3
  const fz = z * 1.3 + t * 0.25
  out.x = Math.sin(fy * 1.7 + fz * 0.9 + t * 0.15) + Math.cos(fz * 2.1 - fx * 0.6) * 0.5
  out.y = Math.sin(fz * 1.9 + fx * 1.1 + t * 0.15) + Math.cos(fx * 2.3 - fy * 0.7) * 0.5
  out.z = Math.sin(fx * 1.5 + fy * 1.3 + t * 0.15) + Math.cos(fy * 1.8 - fz * 0.8) * 0.5
}

// La atracción (resorte hacia target) y su fricción varían según morphEased:
// blandas en Scatter (para el look flotante) y mucho más rígidas/rápidas en
// Settle, para que la forma final se lea nítida casi de inmediato. El ruido
// se atenúa en la misma proporción para no deshacer la silueta, pero nunca
// llega a cero (para que nunca se vea estático).
//
// Importante: la fuerza total (ruido + atracción) se multiplica por
// `speed` más abajo — eso hay que tenerlo en cuenta al calibrar
// ATTRACTION_SETTLE/FRICTION_SETTLE para que, al Velocidad default (0.5), el
// asentado sea casi inmediato (unas pocas décimas de segundo) y sin rebote.
const ATTRACTION_SCATTER = 0.85
const ATTRACTION_SETTLE = 200
const FRICTION_SCATTER = 2.3
const FRICTION_SETTLE = 20
// Cuánto se reduce la fuerza del ruido cuando una partícula ya llegó del
// todo a su posición final (1 = sin reducción, 0 = sin ruido, nada de vida).
const SETTLE_NOISE_DAMPING = 0.15

// Mezcla de remolino (tangencial) y repulsión (radial) que aplica el cursor
// cuando se le pasa un `cursor` activo: así se siente como "viento" que
// levanta el polvo, no un empujón seco.
const CURSOR_SWIRL_WEIGHT = 0.65
const CURSOR_REPEL_WEIGHT = 0.55

// Avanza un paso de simulación para todas las partículas/nodos de
// `particleData`. `cursor` es opcional: { x, y, z, radius, strength } en el
// espacio local del grupo, o null si no aplica (Neural Net no lo usa todavía).
export function stepMorphPhysics(particleData, dt, elapsed, { speed, noiseStrength, cursor }) {
  const { position, velocity, target, random, morphEased } = particleData
  const count = position.length / 3
  const cursorActive = Boolean(cursor)
  const cursorRadiusSq = cursorActive ? cursor.radius * cursor.radius : 0

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3
    const x = position[i3]
    const y = position[i3 + 1]
    const z = position[i3 + 2]
    const eased = morphEased[i]

    const attractionLocal = ATTRACTION_SCATTER + (ATTRACTION_SETTLE - ATTRACTION_SCATTER) * eased
    const frictionLocal = FRICTION_SCATTER + (FRICTION_SETTLE - FRICTION_SCATTER) * eased
    const frictionFactor = Math.exp(-frictionLocal * dt)
    const effectiveNoiseStrength = noiseStrength * (1 - eased * (1 - SETTLE_NOISE_DAMPING))

    curlLikeInto(curlScratch, x, y, z, elapsed + random[i3 + 2] * 6.2831853)
    let fx = curlScratch.x * effectiveNoiseStrength
    let fy = curlScratch.y * effectiveNoiseStrength
    let fz = curlScratch.z * effectiveNoiseStrength

    fx += (target[i3] - x) * attractionLocal
    fy += (target[i3 + 1] - y) * attractionLocal
    fz += (target[i3 + 2] - z) * attractionLocal

    if (cursorActive) {
      const dx = x - cursor.x
      const dy = y - cursor.y
      // El cursor se proyecta sobre z=0: su radio es una región de pantalla,
      // no una esfera delgada que descarte casi todas las partículas con z != 0.
      const distSq = dx * dx + dy * dy
      if (distSq < cursorRadiusSq && distSq > 0.000001) {
        const dist = Math.sqrt(distSq)
        const falloff = 1 - dist / cursor.radius
        const easedFalloff = falloff * falloff
        const invDist = 1 / dist
        const rx = dx * invDist
        const ry = dy * invDist
        const tx = -ry
        const ty = rx
        // Escalar con el resorte mantiene visible la interacción incluso en
        // Settle, donde la atracción 200 y la fricción 20 anulaban el empuje.
        // El radio limita además la excursión a una fracción del área activa.
        const push = cursor.strength * cursor.radius * attractionLocal * easedFalloff
        fx += (rx * CURSOR_REPEL_WEIGHT + tx * CURSOR_SWIRL_WEIGHT) * push
        fy += (ry * CURSOR_REPEL_WEIGHT + ty * CURSOR_SWIRL_WEIGHT) * push
      }
    }

    const vx = (velocity[i3] + fx * speed * dt) * frictionFactor
    const vy = (velocity[i3 + 1] + fy * speed * dt) * frictionFactor
    const vz = (velocity[i3 + 2] + fz * speed * dt) * frictionFactor

    velocity[i3] = vx
    velocity[i3 + 1] = vy
    velocity[i3 + 2] = vz

    position[i3] = x + vx * dt
    position[i3 + 1] = y + vy * dt
    position[i3 + 2] = z + vz * dt
  }
}

export function hexToVector3(hex, target) {
  const color = new THREE.Color(hex)
  return target.set(color.r, color.g, color.b)
}

// Mapeo control (0–1, "Largo de cola") -> damp de AfterimagePass. 0 = sin
// rastro (borra todo cada frame); valores altos acercan damp a ~0.95.
export function trailLengthToDamp(trailLength) {
  return Math.min(Math.max(trailLength, 0), 1) * 0.95
}

// --- Shaders del material de puntos (partículas/nodos) ---
// Compartido entre Stardust (polvo) y Neural Net (nodos): ambos son Points
// con tamaño/brillo variable por partícula y atenuación por perspectiva.
const POINT_SIZE_PERSPECTIVE_K = 6.5

// uDepthNear/uDepthFar son uniforms (no constantes fijas en el shader)
// porque "Escala de silueta" cambia en vivo qué tan grande es el cerebro en
// unidades de mundo; cada preset recalcula y sube estos dos valores cada
// frame (ver uDepthNear/uDepthFar más abajo).
export const POINTS_VERTEX_SHADER = `
// aRandom: tres valores aleatorios fijos por partícula (no cambian en el
// tiempo), usados para variar tamaño, brillo y la fase de su movimiento.
// La posición (position) no se calcula acá: la simulación (CPU) sube el
// resultado a este atributo estándar cada frame.
attribute vec3 aRandom;

uniform float uSize;
uniform float uPixelRatio;
uniform float uDepthNear;
uniform float uDepthFar;

varying float vBrightnessFactor;
varying float vAlphaFactor;
varying float vDepthFactor;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Cámara de perspectiva: entre más lejos está la partícula de la cámara
  // (-mvPosition.z más grande), más chico se dibuja el punto. Es la misma
  // idea que "sizeAttenuation" de THREE.PointsMaterial, pero a mano.
  float sizeFactor = mix(0.5, 2.0, aRandom.y);
  gl_PointSize = uSize * sizeFactor * uPixelRatio * (${POINT_SIZE_PERSPECTIVE_K.toFixed(1)} / -mvPosition.z);

  // 0 = lejos de la cámara, 1 = muy cerca. Lo usamos para que lo cercano
  // brille un poco más (sensación de profundidad además del tamaño).
  vDepthFactor = smoothstep(uDepthFar, uDepthNear, -mvPosition.z);

  vBrightnessFactor = smoothstep(0.75, 1.0, aRandom.x);
  vAlphaFactor = mix(0.35, 1.0, aRandom.x);
}
`

// --- Fondo por efecto ---
// Antes había un degradado fijo en el CSS detrás del canvas, sin ningún
// control. Ahora el fondo lo pinta cada efecto (scene.background de
// three.js): "Ninguno" deja el canvas transparente (se ve la tarjeta oscura
// detrás), "Color sólido"/"Degradado" usan los colores del panel.

// Textura chica (gradiente vertical) para scene.background cuando el tipo
// de fondo es "Degradado". Barata de regenerar cada vez que cambian los
// colores (canvas 2D de 8x256, no hace falta más resolución).
export function createGradientBackgroundTexture(colorA, colorB) {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  gradient.addColorStop(0, colorA)
  gradient.addColorStop(1, colorB)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// Estrellas de fondo: una capa aparte (se agrega directo a `scene`, no al
// group que rota con la forma principal) de puntos blancos chicos con un
// parpadeo suave por estrella, generada por código. Cubre un área grande
// detrás del sujeto para que se vea completa incluso en los bordes.
const STAR_FIELD_HALF_WIDTH = 6
const STAR_FIELD_HALF_HEIGHT = 5
const STAR_FIELD_DEPTH_MIN = 2
const STAR_FIELD_DEPTH_RANGE = 4

const STAR_VERTEX_SHADER = `
attribute float aPhase;
attribute float aSize;
uniform float uPixelRatio;
uniform float uTime;
varying float vTwinkle;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uPixelRatio;
  // Cada estrella parpadea en su propia fase, para que no titilen todas
  // juntas como si fuera un solo flash.
  vTwinkle = 0.55 + 0.45 * sin(uTime * 0.8 + aPhase * 6.2831853);
}
`

const STAR_FRAGMENT_SHADER = `
precision mediump float;
uniform float uBrightness;
varying float vTwinkle;

void main() {
  vec2 centered = gl_PointCoord - vec2(0.5);
  float dist = length(centered) * 2.0;
  float circle = smoothstep(1.0, 0.0, dist);
  // Alpha "derecho" (sin premultiplicar): con blending normal (ver más
  // abajo) three.js ya hace el compuesto correcto a partir de esto.
  float alpha = circle * vTwinkle * uBrightness;
  gl_FragColor = vec4(vec3(1.0), alpha);
}
`

export function createStarField(count, pixelRatio) {
  const positions = new Float32Array(count * 3)
  const phases = new Float32Array(count)
  const sizes = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3
    positions[i3] = (Math.random() * 2 - 1) * STAR_FIELD_HALF_WIDTH
    positions[i3 + 1] = (Math.random() * 2 - 1) * STAR_FIELD_HALF_HEIGHT
    positions[i3 + 2] = -(STAR_FIELD_DEPTH_MIN + Math.random() * STAR_FIELD_DEPTH_RANGE)
    phases[i] = Math.random()
    // Bug corregido: con 1-2.8px (antes de pixelRatio) cada estrella era
    // casi un sub-píxel, casi invisible. Puntos chicos de verdad necesitan
    // más tamaño base para leerse aislados (sin miles de ellos solapándose
    // como el polvo de Stardust, que sí compensa tamaños chicos).
    sizes[i] = 2.5 + Math.random() * 3
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  const material = new THREE.ShaderMaterial({
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // Bug corregido: blending aditivo + alpha premultiplicado sobre un
    // canvas transparente hace que el alpha resultante del compuesto quede
    // ~al cuadrado (se ve casi invisible) cuando el punto está AISLADO
    // (sin miles de vecinos solapados sumando brillo, como sí pasa en
    // Stardust). Con blending normal y alpha derecho, cada estrella se ve
    // con la opacidad que realmente pedís en "Brillo de estrellas".
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uBrightness: { value: 0.5 },
    },
  })
  return new THREE.Points(geometry, material)
}

export const POINTS_FRAGMENT_SHADER = `
precision mediump float;

uniform float uOpacity;
uniform vec3 uColor;

varying float vBrightnessFactor;
varying float vAlphaFactor;
varying float vDepthFactor;

void main() {
  // gl_PointCoord va de (0,0) a (1,1) dentro del punto; centramos para medir
  // la distancia al centro y dibujar un círculo con borde difuminado.
  vec2 centered = gl_PointCoord - vec2(0.5);
  float dist = length(centered) * 2.0;
  float circle = smoothstep(1.0, 0.0, dist);

  // Las partículas cercanas a la cámara se ven un poco más brillantes,
  // reforzando la sensación de profundidad que ya da el tamaño.
  float depthBoost = mix(0.75, 1.2, vDepthFactor);
  float alpha = circle * vAlphaFactor * uOpacity * depthBoost;
  vec3 color = mix(uColor, vec3(1.0), vBrightnessFactor * 0.6 + vDepthFactor * 0.15);

  // Blending aditivo (ver material): multiplicamos color por su propio
  // alpha para que las zonas con muchas partículas encimadas brillen más.
  gl_FragColor = vec4(color * alpha, alpha);
}
`
