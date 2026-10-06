import { useMemo } from 'react'
import { Particles, ParticlesProvider } from '@tsparticles/react'
import { loadSlim } from '@tsparticles/slim'
import { loadPolygonMaskPlugin } from '@tsparticles/plugin-polygon-mask'

// Debe ser una referencia estable entre renders: ParticlesProvider lanza un
// error si el callback `init` cambia ("must be stable across the app lifecycle").
async function initTsParticlesEngine(engine) {
  await loadSlim(engine)
  await loadPolygonMaskPlugin(engine)
}

// Unidades del path SVG inline (no píxeles de pantalla); `polygon.scale`
// multiplica este tamaño base al posicionarlo sobre el canvas real.
const SQUARE_MASK_UNIT_SIZE = 300

function buildOptions(values) {
  return {
    fullScreen: { enable: false },
    detectRetina: true,
    background: { color: { value: values.colorBack } },
    particles: {
      number: { value: values.particleCount },
      color: { value: values.particleColor },
      shape: { type: 'circle' },
      opacity: { value: 0.85 },
      size: { value: { min: 1, max: 3 } },
      links: {
        enable: true,
        distance: 130,
        color: values.linkColor,
        opacity: values.linkOpacity,
        width: 1,
      },
      move: {
        enable: values.motionEnabled,
        speed: values.speed,
        direction: 'none',
        random: false,
        straight: false,
        outModes: { default: 'bounce' },
      },
    },
    // Máscara cuadrada de exploración: la forma exacta no importa para este
    // piloto, solo confinar el efecto de partículas+líneas a una región.
    polygon: {
      enable: true,
      type: 'inside',
      scale: values.maskScale,
      position: { x: 50, y: 50 },
      data: {
        size: { width: SQUARE_MASK_UNIT_SIZE, height: SQUARE_MASK_UNIT_SIZE },
        path: `M0 0 L${SQUARE_MASK_UNIT_SIZE} 0 L${SQUARE_MASK_UNIT_SIZE} ${SQUARE_MASK_UNIT_SIZE} L0 ${SQUARE_MASK_UNIT_SIZE} Z`,
      },
      draw: { enable: false },
      move: { type: 'radius', radius: 10 },
      inline: { arrangement: 'onePerPoint' },
    },
  }
}

function TsParticlesPolygonPreset({ id, values, isPaused }) {
  const options = useMemo(
    () => buildOptions({ ...values, motionEnabled: !isPaused }),
    [values, isPaused]
  )

  return (
    <ParticlesProvider init={initTsParticlesEngine}>
      <Particles id={id} className="shader-lab__shader" options={options} />
    </ParticlesProvider>
  )
}

export default TsParticlesPolygonPreset
