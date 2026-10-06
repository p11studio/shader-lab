import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import {
  MAX_PIXEL_RATIO,
  MAX_DELTA_SECONDS,
  computeDepthRange,
  buildMorphParticleData,
  computeMorphTargets,
  createMorphClock,
  stepMorphPhysics,
  hexToVector3,
  trailLengthToDamp,
  loadBrainMaskSampler,
  regenerateBrainTargets,
  createGradientBackgroundTexture,
  createStarField,
  POINTS_VERTEX_SHADER,
  POINTS_FRAGMENT_SHADER,
} from '../brain-particles/shared'

const ROTATION_SPEED_Y = 0.045
// Segundo eje de rotación (más lento y en relación no exacta con el de Y,
// para que no se sienta como un giro mecánico de una sola vuelta repetida):
// así se percibe mejor el volumen 3D de la forma, no solo su silueta.
const ROTATION_SPEED_X = 0.027
const CAMERA_FOV = 50
const CAMERA_DISTANCE = 4.2

function StardustPreset({ id, values, isPaused, restartToken }) {
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

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 30)
    camera.position.set(0, 0, CAMERA_DISTANCE)
    camera.lookAt(0, 0, 0)

    // Agrupamos las partículas en un Group aparte para poder rotarlas
    // lentamente sin tocar la cámara ni la simulación (que vive en el
    // espacio local de este grupo).
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
    const material = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERTEX_SHADER,
      fragmentShader: POINTS_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSize: { value: valuesRef.current.pointSize },
        uOpacity: { value: valuesRef.current.opacity },
        uPixelRatio: { value: pixelRatio },
        uColor: { value: hexToVector3(valuesRef.current.particleColor, new THREE.Vector3()) },
        uDepthNear: { value: initialDepthRange.uDepthNear },
        uDepthFar: { value: initialDepthRange.uDepthFar },
      },
    })

    // Material de debug: dibuja brainTarget tal cual, sin pasar por la
    // simulación, para confirmar por separado si la silueta procedural
    // "se ve a cerebro" independientemente de cómo ande la física.
    const debugMaterial = new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: 0.035,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })

    let particleData = null
    let geometry = null
    let points = null
    let debugGeometry = null
    let debugPoints = null
    let lastParticleCount = null
    let lastShape = null

    const morphClock = createMorphClock()
    let breathePhase = 0
    let lastRestartToken = restartTokenRef.current

    function rebuildParticles(count, shape) {
      if (points) {
        cloudGroup.remove(points)
        geometry.dispose()
        cloudGroup.remove(debugPoints)
        debugGeometry.dispose()
      }
      particleData = buildMorphParticleData(count, shape, 'surface')
      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(particleData.position, 3))
      geometry.setAttribute('aRandom', new THREE.BufferAttribute(particleData.random, 3))
      points = new THREE.Points(geometry, material)
      cloudGroup.add(points)

      // brainTarget nunca se toca después de generarse, así que la
      // geometría de debug puede apuntar directo a ese array: no necesita
      // needsUpdate por frame.
      debugGeometry = new THREE.BufferGeometry()
      debugGeometry.setAttribute('position', new THREE.BufferAttribute(particleData.brainTarget, 3))
      debugPoints = new THREE.Points(debugGeometry, debugMaterial)
      debugPoints.visible = false
      cloudGroup.add(debugPoints)

      lastParticleCount = count
      lastShape = shape
      morphClock.reset()
    }

    rebuildParticles(valuesRef.current.particleCount, valuesRef.current.shape)

    // La máscara real (/public/masks/brain.svg) carga de forma asíncrona;
    // mientras tanto ya estamos usando el fallback procedural (ver
    // buildMorphParticleData). Cuando resuelve, regeneramos brainTarget con
    // la máscara y las partículas migran ahí solas vía la simulación normal.
    // Solo aplica a la forma "Cerebro": los poliedros no usan máscara.
    let disposed = false
    loadBrainMaskSampler().then((sampler) => {
      if (disposed || !sampler || valuesRef.current.shape !== 'brain') return
      regenerateBrainTargets(particleData, 'brain', 'surface')
    })

    // --- Fondo por efecto: "Ninguno" dejaba scene.background en null
    // (canvas transparente, se ve la tarjeta oscura detrás); "Color sólido"
    // y "Degradado" lo pintan acá. La textura de degradado se regenera solo
    // cuando cambian sus colores.
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

    // --- Estrellas de fondo: capa fija (no rota con cloudGroup) de puntos
    // generados por código, no imagen.
    let starField = createStarField(valuesRef.current.starDensity, pixelRatio)
    scene.add(starField)
    let lastStarDensity = valuesRef.current.starDensity

    // --- Post-procesado: composer con un paso de "afterimage" para las
    // colas/rastros (persistencia de frames anteriores en vez de limpiar el
    // canvas por completo) y un OutputPass final para que los colores
    // salgan con el mismo espacio de color que un render directo.
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const afterimagePass = new AfterimagePass(trailLengthToDamp(valuesRef.current.trailLength))
    composer.addPass(afterimagePass)
    composer.addPass(new OutputPass())

    function resize() {
      const width = container.clientWidth || 1
      const height = container.clientHeight || 1
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      composer.setSize(width, height)
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

    // --- Reacción al cursor: convertimos la posición del mouse a un punto
    // en el plano z=0 del mundo (con raycasting) y lo pasamos al espacio
    // local de cloudGroup, así la interacción sigue quedando "anclada" al
    // dibujo aunque la nube esté rotando.
    const raycaster = new THREE.Raycaster()
    const pointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const pointerNdc = new THREE.Vector2()
    const pointerWorld = new THREE.Vector3()
    const cursorLocal = new THREE.Vector3()
    let isCursorActive = false

    function updateCursorFromEvent(event) {
      const rect = container.getBoundingClientRect()
      pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointerNdc, camera)
      if (raycaster.ray.intersectPlane(pointerPlane, pointerWorld)) {
        cursorLocal.copy(pointerWorld)
        cloudGroup.worldToLocal(cursorLocal)
        isCursorActive = true
      }
    }

    function handlePointerMove(event) {
      if (!valuesRef.current.cursorReactive) return
      updateCursorFromEvent(event)
    }
    function handlePointerLeave() {
      isCursorActive = false
    }
    container.addEventListener('pointermove', handlePointerMove)
    container.addEventListener('pointerleave', handlePointerLeave)

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

      if (
        valuesRef.current.particleCount !== lastParticleCount ||
        valuesRef.current.shape !== lastShape
      ) {
        rebuildParticles(valuesRef.current.particleCount, valuesRef.current.shape)
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
      applyBackground()

      if (!isPausedRef.current) {
        elapsed += dt
        breathePhase += dt * 0.55
        const globalProgress = morphClock.resolveProgress(
          dt,
          valuesRef.current.morphProgress,
          valuesRef.current.loop,
          valuesRef.current.morphMax,
          valuesRef.current.cycleDuration
        )
        computeMorphTargets(
          particleData,
          globalProgress,
          breathePhase,
          valuesRef.current.silhouetteScale,
          valuesRef.current.morphMax
        )
        stepMorphPhysics(particleData, dt, elapsed, {
          speed: valuesRef.current.speed,
          noiseStrength: valuesRef.current.noiseStrength,
          cursor:
            valuesRef.current.cursorReactive && isCursorActive
              ? {
                  x: cursorLocal.x,
                  y: cursorLocal.y,
                  z: cursorLocal.z,
                  radius: valuesRef.current.cursorRadius,
                  strength: valuesRef.current.cursorStrength,
                }
              : null,
        })
        geometry.attributes.position.needsUpdate = true
        cloudGroup.rotation.y += ROTATION_SPEED_Y * dt
        cloudGroup.rotation.x += ROTATION_SPEED_X * dt
      }

      material.uniforms.uSize.value = valuesRef.current.pointSize
      material.uniforms.uOpacity.value = valuesRef.current.opacity
      hexToVector3(valuesRef.current.particleColor, material.uniforms.uColor.value)
      const depthRange = computeDepthRange(
        CAMERA_DISTANCE,
        valuesRef.current.silhouetteScale,
        valuesRef.current.shape
      )
      material.uniforms.uDepthNear.value = depthRange.uDepthNear
      material.uniforms.uDepthFar.value = depthRange.uDepthFar
      afterimagePass.uniforms.damp.value = isPausedRef.current
        ? 0
        : trailLengthToDamp(valuesRef.current.trailLength)

      starField.visible = Boolean(valuesRef.current.showStars)
      starField.material.uniforms.uTime.value = elapsed
      starField.material.uniforms.uBrightness.value = valuesRef.current.starBrightness

      // Debug: muestra brainTarget tal cual (sin física) y oculta la
      // simulación real, para verificar la silueta procedural aislada.
      const showDebugTarget = Boolean(valuesRef.current.debugShowTarget)
      points.visible = !showDebugTarget
      debugPoints.visible = showDebugTarget

      composer.render()
    }
    rafId = requestAnimationFrame(renderFrame)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      container.removeEventListener('pointermove', handlePointerMove)
      container.removeEventListener('pointerleave', handlePointerLeave)
      geometry?.dispose()
      debugGeometry?.dispose()
      material.dispose()
      debugMaterial.dispose()
      starField.geometry.dispose()
      starField.material.dispose()
      gradientTexture?.dispose()
      composer.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={containerRef} id={id} className="shader-lab__shader" />
}

export default StardustPreset
