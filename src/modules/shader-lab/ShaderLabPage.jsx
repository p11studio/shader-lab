import { Fragment, lazy, Suspense, useEffect, useId, useMemo, useState } from 'react'
import { DotGrid, DotOrbit, NeuroNoise } from '@paper-design/shaders-react'
import { DialRoot, useDialKit } from 'dialkit'
import { NEURAL_NET_DEFAULTS } from './neural-net/defaults'
import 'dialkit/styles.css'
import './styles/shader-lab.css'

// No se importa desde brain-particles/shared: ese módulo trae three.js, y
// este archivo (ShaderLabPage) se carga eager, no lazy — importar algo de
// ahí acá infla el bundle principal con three.js completo aunque el usuario
// nunca elija Stardust/Neural Net. Se duplica esta listita chica en vez.
const SHAPE_OPTIONS = [
  { value: 'brain', label: 'Cerebro' },
  { value: 'octahedron', label: 'Octaedro' },
  { value: 'dodecahedron', label: 'Dodecaedro' },
  { value: 'icosahedron', label: 'Icosaedro' },
]

const BACKGROUND_TYPE_OPTIONS = [
  { value: 'none', label: 'Ninguno' },
  { value: 'solid', label: 'Color sólido' },
  { value: 'gradient', label: 'Degradado' },
]

// Campo de luz: @hugol · OpenShaders (https://openshaders.com/@hugol).
// Uso local; confirmar licencia del shader concreto en la fuente oficial antes de publicar.
const NEURAL_NET_BACKGROUND_TYPE_OPTIONS = [
  ...BACKGROUND_TYPE_OPTIONS,
  { value: 'light-field', label: 'Campo de luz' },
]

// Motor pesado (Canvas 2D + plugins tsParticles); se descarga aparte del
// resto del lab y solo cuando el usuario realmente elige este preset.
const TsParticlesPolygonPreset = lazy(() => import('./TsParticlesPolygonPreset'))
// Motor three.js (WebGL puro); igual que tsParticles, se descarga aparte y
// solo cuando el usuario elige este preset.
const StardustPreset = lazy(() => import('./stardust/StardustPreset'))
const NeuralNetPreset = lazy(() => import('./neural-net/NeuralNetPreset'))

const STORAGE_KEY = 'shaderLab.standalone.presets.v1'
const DEFAULT_PRESET_ID = 'dot-orbit'
const STATIC_FRAME = 4800

const PRESET_DEFINITIONS = {
  'dot-orbit': {
    label: 'Dot Orbit',
    description: 'Órbitas suaves con puntos fríos y una paleta de cinco tonos.',
    defaults: {
      colorBack: '#0f1620',
      color1: '#f7fbff',
      color2: '#7dd3fc',
      color3: '#2dd4bf',
      color4: '#8b5cf6',
      color5: '#d946ef',
      speed: 0.12,
      scale: 0.42,
      size: 0.34,
      sizeRange: 0.58,
      spreading: 0.72,
      stepsPerColor: 4,
    },
    controls: [
      { key: 'colorBack', label: 'Fondo', type: 'color' },
      { key: 'color1', label: 'Punto blanco', type: 'color' },
      { key: 'color2', label: 'Azul frío', type: 'color' },
      { key: 'color3', label: 'Teal', type: 'color' },
      { key: 'color4', label: 'Violeta', type: 'color' },
      { key: 'color5', label: 'Magenta', type: 'color' },
      { key: 'speed', label: 'Velocidad', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'scale', label: 'Escala', type: 'range', min: 0.1, max: 2, step: 0.01 },
      { key: 'size', label: 'Tamaño de punto', type: 'range', min: 0.05, max: 1, step: 0.01 },
      { key: 'sizeRange', label: 'Variación de tamaño', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'spreading', label: 'Dispersión orbital', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'stepsPerColor', label: 'Pasos de color', type: 'range', min: 1, max: 4, step: 1 },
    ],
  },
  'dot-grid': {
    label: 'Dot Grid',
    description: 'Retícula estática para estudiar densidad, opacidad y contraste.',
    defaults: {
      colorBack: '#0f1620',
      colorFill: '#dbeafe',
      colorStroke: '#38bdf8',
      scale: 1,
      size: 4,
      gapX: 24,
      gapY: 24,
      strokeWidth: 0.5,
      sizeRange: 0.72,
      opacityRange: 0.62,
    },
    controls: [
      { key: 'colorBack', label: 'Fondo', type: 'color' },
      { key: 'colorFill', label: 'Relleno', type: 'color' },
      { key: 'colorStroke', label: 'Contorno', type: 'color' },
      { key: 'scale', label: 'Escala', type: 'range', min: 0.25, max: 2, step: 0.01 },
      { key: 'size', label: 'Tamaño de punto', type: 'range', min: 1, max: 24, step: 1 },
      { key: 'gapX', label: 'Separación horizontal', type: 'range', min: 8, max: 120, step: 1 },
      { key: 'gapY', label: 'Separación vertical', type: 'range', min: 8, max: 120, step: 1 },
      { key: 'strokeWidth', label: 'Grosor de contorno', type: 'range', min: 0, max: 8, step: 0.5 },
      { key: 'sizeRange', label: 'Variación de tamaño', type: 'range', min: 0, max: 1, step: 0.01 },
      {
        key: 'opacityRange',
        label: 'Variación de opacidad',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
    ],
  },
  'neuro-noise': {
    label: 'Neuro Noise',
    description: 'Campo atmosférico orgánico; no representa conexiones neuronales reales.',
    defaults: {
      colorFront: '#f8fafc',
      colorMid: '#2dd4bf',
      colorBack: '#0f1620',
      brightness: 0.08,
      contrast: 0.42,
      speed: 0.16,
      scale: 1.32,
      rotation: 8,
    },
    controls: [
      { key: 'colorFront', label: 'Foco', type: 'color' },
      { key: 'colorMid', label: 'Tono medio', type: 'color' },
      { key: 'colorBack', label: 'Fondo', type: 'color' },
      { key: 'brightness', label: 'Brillo', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'contrast', label: 'Contraste', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'speed', label: 'Velocidad', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'scale', label: 'Escala', type: 'range', min: 0.2, max: 3, step: 0.01 },
      { key: 'rotation', label: 'Rotación', type: 'range', min: 0, max: 360, step: 1 },
    ],
  },
  'tsparticles-polygon': {
    label: 'Partículas + Polígono (tsParticles)',
    description:
      'Red de partículas y líneas confinada a un polígono (motor Canvas 2D, no GLSL) para comparar contra los campos de Paper Shaders. La forma de la máscara es solo de prueba.',
    defaults: {
      colorBack: '#0f1620',
      particleColor: '#7dd3fc',
      linkColor: '#2dd4bf',
      linkOpacity: 0.4,
      particleCount: 70,
      speed: 1.4,
      maskScale: 1.4,
    },
    controls: [
      { key: 'colorBack', label: 'Fondo', type: 'color' },
      { key: 'particleColor', label: 'Color de partícula', type: 'color' },
      { key: 'linkColor', label: 'Color de línea', type: 'color' },
      {
        key: 'linkOpacity',
        label: 'Opacidad de líneas',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'particleCount',
        label: 'Número de partículas',
        type: 'range',
        min: 10,
        max: 200,
        step: 5,
      },
      { key: 'speed', label: 'Velocidad', type: 'range', min: 0.1, max: 5, step: 0.1 },
      { key: 'maskScale', label: 'Escala de máscara', type: 'range', min: 0.3, max: 3, step: 0.1 },
    ],
  },
  stardust: {
    label: 'Stardust',
    description:
      'Simulación real (three.js, CPU): posición + velocidad con ruido tipo curl, atracción y fricción. Converge en la silueta de /masks/brain.svg (con fallback procedural si la máscara no carga).',
    defaults: {
      shape: 'octahedron',
      particleCount: 12000,
      pointSize: 1.5,
      opacity: 0.6,
      speed: 0.5,
      noiseStrength: 0.6,
      particleColor: '#ffffff',
      trailLength: 0.35,
      cursorReactive: true,
      cursorStrength: 1.6,
      cursorRadius: 0.45,
      morphProgress: 0,
      loop: true,
      morphMax: 0.6,
      cycleDuration: 90,
      silhouetteScale: 1.9,
      backgroundType: 'none',
      backgroundColorA: '#0f1620',
      backgroundColorB: '#1a1033',
      showStars: false,
      starDensity: 150,
      starBrightness: 0.5,
      debugShowTarget: false,
    },
    controls: [
      { key: 'shape', label: 'Forma', type: 'select', options: SHAPE_OPTIONS },
      {
        key: 'particleCount',
        label: 'Número de partículas',
        type: 'range',
        min: 2000,
        max: 30000,
        step: 500,
      },
      { key: 'pointSize', label: 'Tamaño de punto', type: 'range', min: 0.5, max: 4, step: 0.1 },
      { key: 'opacity', label: 'Opacidad', type: 'range', min: 0.1, max: 1, step: 0.01 },
      { key: 'speed', label: 'Velocidad', type: 'range', min: 0.1, max: 2, step: 0.01 },
      {
        key: 'noiseStrength',
        label: 'Fuerza del ruido',
        type: 'range',
        min: 0,
        max: 2,
        step: 0.01,
      },
      { key: 'particleColor', label: 'Color de partícula', type: 'color' },
      { key: 'trailLength', label: 'Largo de cola', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'cursorReactive', label: 'Reaccionar al cursor', type: 'toggle' },
      {
        key: 'cursorStrength',
        label: 'Fuerza del cursor',
        type: 'range',
        min: 0,
        max: 2,
        step: 0.01,
      },
      {
        key: 'cursorRadius',
        label: 'Radio del cursor',
        type: 'range',
        min: 0.05,
        max: 0.6,
        step: 0.01,
      },
      {
        key: 'morphProgress',
        label: 'Progreso de morph',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
      { key: 'loop', label: 'Loop', type: 'toggle' },
      { key: 'morphMax', label: 'Morph máximo', type: 'range', min: 0, max: 1, step: 0.01 },
      {
        key: 'cycleDuration',
        label: 'Duración del ciclo',
        type: 'range',
        min: 5,
        max: 180,
        step: 1,
      },
      {
        key: 'silhouetteScale',
        label: 'Escala de silueta',
        type: 'range',
        min: 1,
        max: 4,
        step: 0.05,
      },
      {
        key: 'backgroundType',
        label: 'Tipo de fondo',
        type: 'select',
        options: BACKGROUND_TYPE_OPTIONS,
      },
      { key: 'backgroundColorA', label: 'Color de fondo', type: 'color' },
      { key: 'backgroundColorB', label: 'Color de fondo 2 (degradado)', type: 'color' },
      { key: 'showStars', label: 'Estrellas de fondo', type: 'toggle' },
      {
        key: 'starDensity',
        label: 'Densidad de estrellas',
        type: 'range',
        min: 50,
        max: 400,
        step: 10,
      },
      {
        key: 'starBrightness',
        label: 'Brillo de estrellas',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: 'debugShowTarget', label: 'Debug: mostrar silueta objetivo', type: 'toggle' },
    ],
  },
  'neural-net': {
    label: 'Neural Net',
    description:
      'Nodos conectados por líneas finas (three.js, CPU) que convergen en la misma silueta de cerebro que Stardust (máscara /masks/brain.svg, con fallback procedural); las conexiones se calculan una sola vez sobre la forma final y aparecen con fade-in durante el morph.',
    defaults: NEURAL_NET_DEFAULTS,
    controls: [
      { key: 'shape', label: 'Forma', type: 'select', options: SHAPE_OPTIONS },
      { key: 'nodeCount', label: 'Número de nodos', type: 'range', min: 100, max: 600, step: 10 },
      { key: 'nodeSize', label: 'Tamaño de nodo', type: 'range', min: 1, max: 6, step: 0.1 },
      { key: 'neighborsK', label: 'Vecinos por nodo (k)', type: 'range', min: 1, max: 6, step: 1 },
      {
        key: 'maxConnectionDistance',
        label: 'Distancia máx. de conexión',
        type: 'range',
        min: 0.05,
        max: 0.4,
        step: 0.01,
      },
      {
        key: 'lineOpacity',
        label: 'Opacidad de líneas',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
      { key: 'nodeColor', label: 'Color de nodo', type: 'color' },
      { key: 'lineColor', label: 'Color de línea', type: 'color' },
      {
        key: 'lineBreatheIntensity',
        label: 'Respiración de líneas',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: 'lineBreathePeriod',
        label: 'Ritmo de respiración',
        type: 'range',
        min: 3,
        max: 20,
        step: 0.5,
      },
      { key: 'speed', label: 'Velocidad', type: 'range', min: 0.1, max: 2, step: 0.01 },
      {
        key: 'morphProgress',
        label: 'Progreso de morph',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
      { key: 'loop', label: 'Loop', type: 'toggle' },
      { key: 'morphMin', label: 'Morph mínimo', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'morphMax', label: 'Morph máximo', type: 'range', min: 0, max: 1, step: 0.01 },
      {
        key: 'cycleDuration',
        label: 'Duración del ciclo',
        type: 'range',
        min: 5,
        max: 180,
        step: 1,
      },
      {
        key: 'silhouetteScale',
        label: 'Escala de silueta',
        type: 'range',
        min: 1,
        max: 4,
        step: 0.05,
      },
      {
        key: 'backgroundType',
        label: 'Tipo de fondo',
        type: 'select',
        options: NEURAL_NET_BACKGROUND_TYPE_OPTIONS,
      },
      { key: 'backgroundColorA', label: 'Color de fondo', type: 'color' },
      { key: 'backgroundColorB', label: 'Color de fondo 2 (degradado)', type: 'color' },
      {
        key: 'lightFieldIntensity',
        label: 'Intensidad del campo de luz',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: 'lightFieldBreathAmplitude',
        label: 'Respiración del fondo',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        key: 'lightFieldBreathPeriod',
        label: 'Ritmo de respiración del fondo',
        type: 'range',
        min: 4,
        max: 30,
        step: 1,
      },
      {
        key: 'lightFieldSpeed',
        label: 'Velocidad del campo de luz',
        type: 'range',
        min: 0.1,
        max: 2,
        step: 0.01,
      },
      { key: 'lightFieldTint', label: 'Tono del campo de luz', type: 'color' },
      { key: 'showStars', label: 'Estrellas de fondo', type: 'toggle' },
      {
        key: 'starDensity',
        label: 'Densidad de estrellas',
        type: 'range',
        min: 50,
        max: 400,
        step: 10,
      },
      {
        key: 'starBrightness',
        label: 'Brillo de estrellas',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: 'pulses', label: 'Pulsos', type: 'toggle' },
      { key: 'debugShowTarget', label: 'Debug: mostrar silueta objetivo', type: 'toggle' },
    ],
  },
}

// Librería real detrás de cada preset, para el primer chip del resumen de
// settings (ver SettingsSummary).
const PRESET_LIBRARY = {
  'dot-orbit': 'Paper Shaders React',
  'dot-grid': 'Paper Shaders React',
  'neuro-noise': 'Paper Shaders React',
  'tsparticles-polygon': 'tsParticles',
  stardust: 'three.js',
  'neural-net': 'three.js',
}

// Orden del dropdown de presets: Neural Net y Stardust primero, después el
// resto en el orden de siempre. Separado de PRESET_DEFINITIONS a propósito
// (ese objeto no cambia de orden) para no tener que mover sus bloques
// enteros en el archivo.
const PRESET_ORDER = [
  'neural-net',
  'stardust',
  'dot-orbit',
  'dot-grid',
  'neuro-noise',
  'tsparticles-polygon',
]

// Redondea a la cantidad de decimales que tenga el `step` del control (p.ej.
// step=500 -> 0 decimales, step=0.01 -> 2) y agrega separador de miles.
function formatRangeValue(control, value) {
  const stepStr = String(control.step ?? 1)
  const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: decimals })
}

function formatPresetStatusLabel(presetStatus) {
  if (!presetStatus.name) return 'Sin preset'
  return presetStatus.dirty ? `${presetStatus.name} · modificado` : presetStatus.name
}

// Derivado de PRESET_DEFINITIONS[presetId] para que cada piloto DialKit
// nunca quede desincronizado de los controles/rangos existentes.
function buildDialkitConfig(presetId) {
  const definition = PRESET_DEFINITIONS[presetId]
  return Object.fromEntries(
    definition.controls
      // Los "select" (p.ej. "Forma") se gobiernan solo desde el panel
      // principal: DialKit no los expone, para no arriesgar un formato de
      // config distinto al que espera su SelectConfig.
      .filter((control) => control.type !== 'select')
      .map((control) => {
        const defaultValue = definition.defaults[control.key]
        // DialKit acepta colores y booleanos como valor crudo; los rangos
        // numéricos van como tupla [valor, min, max, step].
        return control.type === 'color' || control.type === 'toggle'
          ? [control.key, defaultValue]
          : [control.key, [defaultValue, control.min, control.max, control.step]]
      })
  )
}

// Presets con piloto DialKit disponible. Agregar un preset acá basta para
// que aparezca en el switch "DialKit" del toolbar (ver useDialKit más abajo).
const DIALKIT_PILOTS = {
  'neuro-noise': { panelId: 'shader-lab-neuro-noise-pilot', label: 'Neuro Noise Pilot' },
  stardust: { panelId: 'shader-lab-stardust-pilot', label: 'Stardust Pilot' },
  'neural-net': { panelId: 'shader-lab-neural-net-pilot', label: 'Neural Net Pilot' },
}
const NEURO_NOISE_DIALKIT_CONFIG = buildDialkitConfig('neuro-noise')
const STARDUST_DIALKIT_CONFIG = buildDialkitConfig('stardust')
const NEURAL_NET_DIALKIT_CONFIG = buildDialkitConfig('neural-net')

function createConfiguration(presetId = DEFAULT_PRESET_ID) {
  return {
    presetId,
    values: { ...PRESET_DEFINITIONS[presetId].defaults },
  }
}

function cloneConfiguration(configuration) {
  return {
    ...configuration,
    values: { ...configuration.values },
  }
}

function readSavedPresets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) =>
      item && typeof item.id === 'string' && typeof item.name === 'string' &&
      PRESET_DEFINITIONS[item.configuration?.presetId] &&
      item.configuration.values && typeof item.configuration.values === 'object' &&
      !Array.isArray(item.configuration.values)
    ) : []
  } catch {
    return []
  }
}

function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches)
    updatePreference()
    mediaQuery.addEventListener('change', updatePreference)
    return () => mediaQuery.removeEventListener('change', updatePreference)
  }, [])

  return prefersReducedMotion
}

function useWebGlSupport() {
  const [isSupported, setIsSupported] = useState(null)

  useEffect(() => {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl2')
    setIsSupported(Boolean(context))
    context?.getExtension('WEBGL_lose_context')?.loseContext()
  }, [])

  return isSupported
}

function getPresetThumbnailBackground(configuration) {
  const { presetId, values } = configuration

  if (presetId === 'neuro-noise') {
    return `radial-gradient(circle at 30% 40%, ${values.colorMid}99, transparent 60%), linear-gradient(120deg, ${values.colorBack} 0%, #0f2438 50%, #4c1d6f 100%)`
  }
  if (presetId === 'dot-grid') {
    return `radial-gradient(circle at 30% 30%, ${values.colorStroke}55, transparent 55%), linear-gradient(135deg, ${values.colorBack} 0%, #16202c 100%)`
  }
  if (presetId === 'tsparticles-polygon') {
    return `radial-gradient(circle at 35% 35%, ${values.particleColor}55, transparent 55%), linear-gradient(135deg, ${values.colorBack} 0%, #16202c 100%)`
  }
  if (presetId === 'stardust') {
    return `radial-gradient(circle at 50% 35%, ${values.particleColor}40, transparent 60%), linear-gradient(135deg, #0b0f16 0%, #171d29 100%)`
  }
  if (presetId === 'neural-net') {
    return `radial-gradient(circle at 50% 35%, ${values.lineColor}40, transparent 60%), linear-gradient(135deg, #0b0f16 0%, #171d29 100%)`
  }
  return `radial-gradient(circle at 30% 40%, ${values.color3}66, transparent 55%), linear-gradient(120deg, ${values.colorBack} 0%, #1d2b3f 50%, #4c1d6f 100%)`
}

function Switch({ checked, onChange, disabled, ariaLabel }) {
  return (
    <label className={`shader-lab__switch${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={ariaLabel}
      />
      <span className="shader-lab__switch-track">
        <span className="shader-lab__switch-thumb" />
      </span>
    </label>
  )
}

function ShaderRenderer({ configuration, isPaused, dialkitOverride, label, restartToken }) {
  const { presetId, values } = configuration
  const commonProps = {
    width: '100%',
    height: '100%',
    className: 'shader-lab__shader',
    fit: 'cover',
    minPixelRatio: 1,
    maxPixelCount: 1800000,
  }

  if (presetId === 'tsparticles-polygon') {
    return (
      <Suspense
        fallback={
          <div className="shader-lab__fallback" role="status">
            Cargando tsParticles…
          </div>
        }
      >
        <TsParticlesPolygonPreset
          id={`shader-lab-tsparticles-${label}`}
          values={values}
          isPaused={isPaused}
        />
      </Suspense>
    )
  }

  if (presetId === 'stardust') {
    const effective = dialkitOverride ? { ...values, ...dialkitOverride } : values
    return (
      <Suspense
        fallback={
          <div className="shader-lab__fallback" role="status">
            Cargando Stardust…
          </div>
        }
      >
        <StardustPreset
          id={`shader-lab-stardust-${label}`}
          values={effective}
          isPaused={isPaused}
          restartToken={restartToken}
        />
      </Suspense>
    )
  }

  if (presetId === 'neural-net') {
    const effective = dialkitOverride ? { ...values, ...dialkitOverride } : values
    return (
      <Suspense
        fallback={
          <div className="shader-lab__fallback" role="status">
            Cargando Neural Net…
          </div>
        }
      >
        <NeuralNetPreset
          id={`shader-lab-neural-net-${label}`}
          values={effective}
          isPaused={isPaused}
          restartToken={restartToken}
        />
      </Suspense>
    )
  }

  if (presetId === 'dot-grid') {
    return (
      <DotGrid
        {...commonProps}
        colorBack={values.colorBack}
        colorFill={values.colorFill}
        colorStroke={values.colorStroke}
        scale={values.scale}
        size={values.size}
        gapX={values.gapX}
        gapY={values.gapY}
        strokeWidth={values.strokeWidth}
        sizeRange={values.sizeRange}
        opacityRange={values.opacityRange}
        shape="circle"
      />
    )
  }

  if (presetId === 'neuro-noise') {
    const effective = dialkitOverride ? { ...values, ...dialkitOverride } : values
    return (
      <NeuroNoise
        {...commonProps}
        colorFront={effective.colorFront}
        colorMid={effective.colorMid}
        colorBack={effective.colorBack}
        brightness={effective.brightness}
        contrast={effective.contrast}
        speed={isPaused ? 0 : effective.speed}
        frame={isPaused ? STATIC_FRAME : 0}
        scale={effective.scale}
        rotation={effective.rotation}
      />
    )
  }

  return (
    <DotOrbit
      {...commonProps}
      colors={[values.color1, values.color2, values.color3, values.color4, values.color5]}
      colorBack={values.colorBack}
      speed={isPaused ? 0 : values.speed}
      frame={isPaused ? STATIC_FRAME : 0}
      scale={values.scale}
      size={values.size}
      sizeRange={values.sizeRange}
      spreading={values.spreading}
      stepsPerColor={values.stepsPerColor}
      offsetX={-0.24}
    />
  )
}

// Un chip por librería + un chip por cada control del preset activo, con su
// valor en vivo. Los que difieren del default del preset se resaltan
// (is-changed) para que se note de un vistazo qué se tocó.
// Lista de filas (no chips sueltos) para que dos tarjetas A/B alineen renglón
// a renglón y sea fácil comparar los valores de un lado contra el otro.
function SettingsSummary({ configuration }) {
  const { presetId, values } = configuration
  const definition = PRESET_DEFINITIONS[presetId]

  return (
    <div className="shader-lab__summary">
      <div className="shader-lab__summary-row shader-lab__summary-row--library">
        <span className="shader-lab__summary-label">Librería</span>
        <span className="shader-lab__summary-value">{PRESET_LIBRARY[presetId]}</span>
      </div>
      {definition.controls.map((control) => {
        const value = values[control.key]
        const isChanged = value !== definition.defaults[control.key]
        const rowClassName = `shader-lab__summary-row${isChanged ? ' is-changed' : ''}`

        if (control.type === 'color') {
          return (
            <div key={control.key} className={rowClassName}>
              <span className="shader-lab__summary-label">{control.label}</span>
              <span className="shader-lab__summary-value">
                <span className="shader-lab__summary-swatch" style={{ backgroundColor: value }} />
                {value.toUpperCase()}
              </span>
            </div>
          )
        }

        let displayValue
        if (control.type === 'toggle') {
          displayValue = value ? 'On' : 'Off'
        } else if (control.type === 'select') {
          displayValue = control.options.find((option) => option.value === value)?.label ?? value
        } else {
          displayValue = formatRangeValue(control, value)
        }

        return (
          <div key={control.key} className={rowClassName}>
            <span className="shader-lab__summary-label">{control.label}</span>
            <span className="shader-lab__summary-value">{displayValue}</span>
          </div>
        )
      })}
    </div>
  )
}

function Preview({
  configuration,
  isPaused,
  isSupported,
  label,
  onEdit,
  isActive,
  dialkitOverride,
  presetStatus,
  restartToken,
}) {
  const definition = PRESET_DEFINITIONS[configuration.presetId]

  return (
    <article className={`shader-lab__preview-card ${isActive ? 'is-active' : ''}`}>
      <header className="shader-lab__preview-header">
        <div>
          <span className="shader-lab__eyebrow">{formatPresetStatusLabel(presetStatus)}</span>
          <h2>{definition.label}</h2>
        </div>
        {onEdit && (
          <button className="shader-lab__text-button" type="button" onClick={onEdit}>
            Editar {label}
          </button>
        )}
      </header>
      <div className="shader-lab__canvas" aria-label={`Lienzo ${label}: ${definition.label}`}>
        {isSupported === false ? (
          <div className="shader-lab__fallback" role="status">
            <strong>WebGL no está disponible</strong>
            <span>Se muestra el fondo degradado de respaldo.</span>
          </div>
        ) : isSupported === true ? (
          <ShaderRenderer
            key={configuration.presetId}
            configuration={configuration}
            isPaused={isPaused}
            dialkitOverride={dialkitOverride}
            label={label}
            restartToken={restartToken}
          />
        ) : (
          <div className="shader-lab__fallback" role="status">
            Comprobando WebGL…
          </div>
        )}
      </div>
      <SettingsSummary configuration={configuration} />
    </article>
  )
}

function ValueControl({ control, value, onChange, idPrefix }) {
  const inputId = `${idPrefix}-${control.key}`

  if (control.type === 'select') {
    return (
      <div className="shader-lab__pill shader-lab__pill--select">
        <label htmlFor={inputId}>{control.label}</label>
        <select
          id={inputId}
          value={value}
          onChange={(event) => onChange(control.key, event.target.value)}
        >
          {control.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (control.type === 'toggle') {
    return (
      <div className="shader-lab__pill shader-lab__pill--toggle">
        <span>{control.label}</span>
        <Switch
          checked={Boolean(value)}
          onChange={(event) => onChange(control.key, event.target.checked)}
          ariaLabel={control.label}
        />
      </div>
    )
  }

  if (control.type === 'color') {
    return (
      <div className="shader-lab__pill shader-lab__pill--color">
        <label htmlFor={inputId}>{control.label}</label>
        <span className="shader-lab__pill-color-value">
          <output htmlFor={inputId}>{value.toUpperCase()}</output>
          <input
            id={inputId}
            type="color"
            value={value}
            onChange={(event) => onChange(control.key, event.target.value)}
          />
        </span>
      </div>
    )
  }

  const percent = ((value - control.min) / (control.max - control.min)) * 100

  return (
    <div className="shader-lab__pill shader-lab__pill--range">
      <input
        id={inputId}
        className="shader-lab__pill-range-input"
        type="range"
        min={control.min}
        max={control.max}
        step={control.step}
        value={value}
        aria-label={control.label}
        onChange={(event) => onChange(control.key, Number(event.target.value))}
        style={{
          background: `linear-gradient(to right, #23303f 0%, #23303f ${percent}%, #14181f ${percent}%, #14181f 100%)`,
        }}
      />
      <div className="shader-lab__pill-range-overlay">
        <span>{control.label}</span>
        <output htmlFor={inputId}>{value}</output>
      </div>
    </div>
  )
}

function ShaderLabPage() {
  const controlId = useId()
  const prefersReducedMotion = useReducedMotion()
  const isWebGlSupported = useWebGlSupport()
  const [configurationA, setConfigurationA] = useState(() => createConfiguration())
  const [configurationB, setConfigurationB] = useState(() => createConfiguration('neuro-noise'))
  const [activeSide, setActiveSide] = useState('A')
  const [comparisonMode, setComparisonMode] = useState(false)
  const [isManuallyPaused, setIsManuallyPaused] = useState(false)
  const [savedPresets, setSavedPresets] = useState(readSavedPresets)
  const [presetName, setPresetName] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  // Qué preset local está cargado en cada lado (y si se tocó algo después),
  // para el encabezado de cada tarjeta ("stardust-1", "stardust-1 ·
  // modificado", "Sin preset").
  const [presetStatusA, setPresetStatusA] = useState({ name: null, dirty: false })
  const [presetStatusB, setPresetStatusB] = useState({ name: null, dirty: false })
  // Se suma 1 cada vez que se toca "Reiniciar loop" en ese lado; Stardust y
  // Neural Net lo ven cambiar y reinician el ciclo de morph (solo eso, no
  // el preset entero como el botón "Reset" de arriba).
  const [restartTokenA, setRestartTokenA] = useState(0)
  const [restartTokenB, setRestartTokenB] = useState(0)
  const [dialkitPilotEnabled, setDialkitPilotEnabled] = useState(false)
  const dialkitNeuroNoiseValues = useDialKit(
    DIALKIT_PILOTS['neuro-noise'].label,
    NEURO_NOISE_DIALKIT_CONFIG,
    { id: DIALKIT_PILOTS['neuro-noise'].panelId, persist: false }
  )
  const dialkitStardustValues = useDialKit(DIALKIT_PILOTS.stardust.label, STARDUST_DIALKIT_CONFIG, {
    id: DIALKIT_PILOTS.stardust.panelId,
    persist: false,
  })
  const dialkitNeuralNetValues = useDialKit(
    DIALKIT_PILOTS['neural-net'].label,
    NEURAL_NET_DIALKIT_CONFIG,
    { id: DIALKIT_PILOTS['neural-net'].panelId, persist: false }
  )
  // Mapa presetId -> valores en vivo de su piloto DialKit (si lo tiene). Ver
  // DIALKIT_PILOTS más arriba para agregar un preset nuevo a esta lista.
  const dialkitValuesByPreset = {
    'neuro-noise': dialkitNeuroNoiseValues,
    stardust: dialkitStardustValues,
    'neural-net': dialkitNeuralNetValues,
  }
  // El toggle, el override y el montaje de DialRoot solo existen en desarrollo:
  // en producción no debe haber UI ni sustitución silenciosa de valores.
  const isDialkitPilotAvailable = import.meta.env.DEV

  const activeConfiguration = activeSide === 'A' ? configurationA : configurationB
  const setActiveConfiguration = activeSide === 'A' ? setConfigurationA : setConfigurationB
  const presetStatus = activeSide === 'A' ? presetStatusA : presetStatusB
  const setPresetStatus = activeSide === 'A' ? setPresetStatusA : setPresetStatusB
  const setActiveRestartToken = activeSide === 'A' ? setRestartTokenA : setRestartTokenB
  const handleRestartLoop = () => setActiveRestartToken((token) => token + 1)
  const activeDefinition = PRESET_DEFINITIONS[activeConfiguration.presetId]
  const isPaused = isManuallyPaused || prefersReducedMotion
  const dialkitPilotPresetLabels = Object.keys(DIALKIT_PILOTS)
    .map((presetId) => PRESET_DEFINITIONS[presetId].label)
    .join(', ')

  const presetOptions = useMemo(
    () =>
      PRESET_ORDER.map((value) => ({
        value,
        label: PRESET_DEFINITIONS[value].label,
      })),
    []
  )

  const updateActiveConfiguration = (updater) => {
    setActiveConfiguration((current) => updater(cloneConfiguration(current)))
    // Si había un preset cargado y limpio en este lado, cualquier cambio de
    // control lo marca como modificado.
    setPresetStatus((current) =>
      current.name && !current.dirty ? { ...current, dirty: true } : current
    )
  }

  const handlePresetChange = (presetId) => {
    setActiveConfiguration(createConfiguration(presetId))
    setPresetStatus({ name: null, dirty: false })
    setStatusMessage(`${PRESET_DEFINITIONS[presetId].label} aplicado al lienzo ${activeSide}.`)
  }

  const handleValueChange = (key, value) => {
    updateActiveConfiguration((next) => ({
      ...next,
      values: { ...next.values, [key]: value },
    }))
  }

  const persistSavedPresets = (nextPresets) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPresets))
    setSavedPresets(nextPresets)
  }

  const handleSavePreset = (event) => {
    event.preventDefault()
    const name = presetName.trim()
    if (!name) {
      setStatusMessage('Escribe un nombre antes de guardar.')
      return
    }

    const existingPreset = [...savedPresets].reverse().find((preset) => preset?.name === name)
    const savedPreset = {
      id: existingPreset?.id || globalThis.crypto?.randomUUID?.() || `${Date.now()}`,
      name,
      configuration: cloneConfiguration(activeConfiguration),
    }
    persistSavedPresets([...savedPresets.filter((preset) => preset?.name !== name), savedPreset])
    setPresetStatus({ name, dirty: false })
    setPresetName('')
    setStatusMessage(`Preset “${name}” ${existingPreset ? 'actualizado' : 'guardado'}.`)
  }

  const handleLoadPreset = (savedPreset) => {
    const configuration = cloneConfiguration(savedPreset.configuration)
    const defaults = PRESET_DEFINITIONS[configuration.presetId].defaults
    configuration.values = { ...defaults, ...configuration.values }
    setActiveConfiguration(configuration)
    setPresetStatus({ name: savedPreset.name, dirty: false })
    setStatusMessage(`Preset “${savedPreset.name}” cargado en ${activeSide}.`)
  }

  const handleDeletePreset = (presetId, presetLabel) => {
    persistSavedPresets(savedPresets.filter((preset) => preset.id !== presetId))
    // Si ese preset estaba mostrado como cargado en algún lado, lo limpiamos
    // (ya no existe, mostrar su nombre sería engañoso).
    setPresetStatusA((current) =>
      current.name === presetLabel ? { name: null, dirty: false } : current
    )
    setPresetStatusB((current) =>
      current.name === presetLabel ? { name: null, dirty: false } : current
    )
    setStatusMessage(`Preset “${presetLabel}” eliminado.`)
  }

  const handleReset = () => {
    setActiveConfiguration(createConfiguration())
    setPresetStatus({ name: null, dirty: false })
    setStatusMessage(`Lienzo ${activeSide} restablecido a Dot Orbit.`)
  }

  return (
    <main className="shader-lab">
      <section className="shader-lab__workspace" aria-label="Laboratorio de shaders">
        <aside className="shader-lab__panel" aria-label="Controles del shader">
          <div className="shader-lab__panel-topbar">
            <div>
              <span className="shader-lab__eyebrow">Exploración aislada · Paper Shaders</span>
              <h1>Shader Lab</h1>
              <p>
                Explora y compara shaders en un lienzo independiente.
              </p>
            </div>
          </div>

          <div className="shader-lab__panel-section">
            <div className="shader-lab__preset-card">
              <select
                id={`${controlId}-preset`}
                className="shader-lab__preset-card-select"
                aria-label={`Preset del lienzo ${activeSide}`}
                value={activeConfiguration.presetId}
                onChange={(event) => handlePresetChange(event.target.value)}
              >
                {presetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <div
                className="shader-lab__preset-thumbnail"
                style={{ background: getPresetThumbnailBackground(activeConfiguration) }}
              />
              <div className="shader-lab__preset-card-footer">
                <div>
                  <strong>{activeDefinition.label}</strong>
                  <span>{activeDefinition.description}</span>
                </div>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M4 6L8 10L12 6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>

            <div className="shader-lab__controls-header">
              <span>Controles</span>
              <button type="button" onClick={handleReset}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.6 0 3.02.68 4.02 1.77M12.5 2v3h-3"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Reset
              </button>
            </div>

            <div className="shader-lab__pill-list">
              {activeDefinition.controls.map((control) => (
                <Fragment key={control.key}>
                  <ValueControl
                    control={control}
                    value={activeConfiguration.values[control.key]}
                    idPrefix={`${controlId}-${activeSide}`}
                    onChange={handleValueChange}
                  />
                  {control.key === 'loop' && (
                    <button
                      className="shader-lab__pill shader-lab__pill--action"
                      type="button"
                      onClick={handleRestartLoop}
                    >
                      Reiniciar loop
                    </button>
                  )}
                </Fragment>
              ))}
            </div>
          </div>
        </aside>

        <section className="shader-lab__stage" aria-label="Lienzos de shader">
          <div className="shader-lab__stage-toolbar">
            <div>
              <span className="shader-lab__eyebrow">Lienzo de shader</span>
              <h2>{comparisonMode ? 'Comparación A/B' : 'Modo normal'}</h2>
            </div>
            <div className="shader-lab__toolbar-actions">
              <button
                className="shader-lab__button"
                type="button"
                aria-pressed={comparisonMode}
                onClick={() => {
                  setComparisonMode((current) => {
                    const next = !current
                    // Fuera de A/B solo se renderiza A: si B quedó activo, el
                    // piloto DialKit gobernaría una configuración invisible.
                    if (!next) {
                      setActiveSide('A')
                    }
                    return next
                  })
                }}
              >
                {comparisonMode ? 'Salir de A/B' : 'Comparar A/B'}
              </button>
              {isDialkitPilotAvailable && (
                <div
                  className={`shader-lab__pill shader-lab__pill--toggle shader-lab__dialkit-toggle${
                    !DIALKIT_PILOTS[activeConfiguration.presetId] ? ' is-disabled' : ''
                  }`}
                  title={
                    !DIALKIT_PILOTS[activeConfiguration.presetId]
                      ? `DialKit solo gobierna ${dialkitPilotPresetLabels} (lienzo ${activeSide} usa ${activeDefinition.label})`
                      : undefined
                  }
                >
                  <span>DialKit</span>
                  <Switch
                    checked={dialkitPilotEnabled}
                    disabled={!DIALKIT_PILOTS[activeConfiguration.presetId]}
                    onChange={(event) => setDialkitPilotEnabled(event.target.checked)}
                    ariaLabel="Piloto DialKit para el preset activo"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="shader-lab__stage-extras">
            <button
              className="shader-lab__pill shader-lab__pill--action"
              type="button"
              aria-pressed={isManuallyPaused}
              onClick={() => setIsManuallyPaused((current) => !current)}
            >
              {isManuallyPaused ? 'Reanudar movimiento' : 'Pausar movimiento'}
            </button>
            {prefersReducedMotion && (
              <p className="shader-lab__motion-note" role="status">
                Movimiento reducido activo: se conserva un frame estático estable.
              </p>
            )}

            <span className="shader-lab__section-label">Presets locales</span>
            <form
              className="shader-lab__save-form shader-lab__save-form--compact"
              onSubmit={handleSavePreset}
            >
              <input
                type="text"
                maxLength="48"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                placeholder="Ej. Launch banner"
                aria-label="Nombre del preset"
              />
              <button className="shader-lab__button shader-lab__button--primary" type="submit">
                Guardar
              </button>
            </form>

            {savedPresets.length > 0 ? (
              <div className="shader-lab__preset-chips">
                {savedPresets.map((preset) => (
                  <div key={preset.id} className="shader-lab__preset-chip">
                    <button
                      type="button"
                      className="shader-lab__preset-chip-load"
                      title={PRESET_DEFINITIONS[preset.configuration.presetId]?.label || 'Preset'}
                      onClick={() => handleLoadPreset(preset)}
                    >
                      {preset.name}
                    </button>
                    <button
                      type="button"
                      className="shader-lab__preset-chip-remove"
                      aria-label={`Eliminar preset ${preset.name}`}
                      onClick={() => handleDeletePreset(preset.id, preset.name)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="shader-lab__empty">Aún no hay presets guardados en este navegador.</p>
            )}
          </div>

          <div
            className={`shader-lab__previews ${comparisonMode ? 'shader-lab__previews--split' : ''}`}
          >
            <Preview
              configuration={configurationA}
              isPaused={isPaused}
              isSupported={isWebGlSupported}
              label="A"
              isActive={activeSide === 'A'}
              onEdit={comparisonMode ? () => setActiveSide('A') : null}
              presetStatus={presetStatusA}
              restartToken={restartTokenA}
              dialkitOverride={
                isDialkitPilotAvailable && dialkitPilotEnabled && activeSide === 'A'
                  ? dialkitValuesByPreset[configurationA.presetId]
                  : null
              }
            />
            {comparisonMode && (
              <Preview
                configuration={configurationB}
                isPaused={isPaused}
                isSupported={isWebGlSupported}
                label="B"
                isActive={activeSide === 'B'}
                presetStatus={presetStatusB}
                restartToken={restartTokenB}
                dialkitOverride={
                  isDialkitPilotAvailable && dialkitPilotEnabled && activeSide === 'B'
                    ? dialkitValuesByPreset[configurationB.presetId]
                    : null
                }
                onEdit={() => setActiveSide('B')}
              />
            )}
          </div>
        </section>
      </section>

      <div className="shader-lab__sr-status" aria-live="polite">
        {statusMessage}
      </div>

      {/*
        No forzamos productionEnabled={false}: en dialkit@2.0.2 esa prop actúa
        como "renderizar sí/no" (`if (!productionEnabled) return null`), no como
        "estamos en producción". Su default ya resuelve a false en builds de
        producción (import.meta.env.MODE === 'production') y a true en dev, que
        es exactamente el comportamiento seguro que se buscaba. Además solo
        montamos el root cuando el piloto está encendido: así un panel visible
        nunca puede parecer que gobierna el shader mientras el override está
        apagado.
      */}
      {isDialkitPilotAvailable &&
        dialkitPilotEnabled &&
        DIALKIT_PILOTS[activeConfiguration.presetId] &&
        <DialRoot position="bottom-right" />}
    </main>
  )
}

export default ShaderLabPage
