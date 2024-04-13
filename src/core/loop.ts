import type { Ref } from 'vue'
import { ref } from 'vue'
import { Clock, MathUtils } from 'three'
import type { Fn } from '@vueuse/core'

export interface RendererLoop {
  subscribers: Map<number, Fn[]>
  loopId: string
  onLoop: (callback: Fn, index: number) => void
  start: () => void
  stop: () => void
  isActive: Ref<boolean>
}

export function createRenderLoop(): RendererLoop {
  const clock = new Clock(false)
  const isActive = ref(false)

  let animationFrameId: number
  const loopId = MathUtils.generateUUID()

  const subscribers = new Map()

  type LoopCallback = (params: {
    delta: number
    elapsed: number
    clock: Clock
  }) => void

  function registerCallback(callback: LoopCallback, index = 0) {
    if (index === 1) {
      // Take control over the main loop
      subscribers.set(index, [callback])
    }
    else {
      // Standard behavior: accumulate callbacks at the given index
      if (!subscribers.has(index)) {
        subscribers.set(index, [])
      }
      subscribers.get(index).push(callback)
    }
  }

  function start() {
    if (!isActive.value) {
      clock.start()
      isActive.value = true
      loop()
    }
  }

  function stop() {
    if (isActive.value) {
      clock.stop()
      cancelAnimationFrame(animationFrameId)
      isActive.value = false
    }
  }

  function loop() {
    const delta = clock.getDelta()
    const elapsed = clock.getElapsedTime()
    /* console.log('loop', animationFrameId) */

    // Sort and execute callbacks based on index
    Array.from(subscribers.keys())
      .sort((a, b) => a - b) // Ensure numerical order
      .forEach((index) => {
        subscribers.get(index).forEach((callback: LoopCallback) => {
          callback({ delta, elapsed, clock })
        })
      })

    if (isActive.value) {
      animationFrameId = requestAnimationFrame(loop)
    }
  }

  return {
    subscribers,
    loopId,
    start,
    stop,
    onLoop: (callback: LoopCallback, index = 0) => registerCallback(callback, index),
    isActive,
  }
}