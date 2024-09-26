import { Raycaster, Vector2, Vector3 } from 'three'
import type { Object3D, Intersection as ThreeIntersection } from 'three'
import { prepareTresInstance } from '..'
import { isProd, type TresContext, useLogger } from '../../composables'
import * as is from '../is'
import { DOM_EVENT_NAMES, DOM_TO_PASSIVE, DOM_TO_THREE, type DomEventName, type DomEventTarget, POINTER_EVENT_NAMES, THREE_EVENT_NAMES } from './const'
import { deprecatedEventsToNewEvents } from './deprecatedEvents'
import type { EventHandlers, IntersectionEvent, Properties, ThreeEvent, TresCamera, TresInstance, TresObject } from '../../types'
import type { CreateEventManagerProps } from './createEventManager'

// NOTE:
// This file consists of type definitions and functions
// used by `./createEventManager`.
//
// In particular, see `handle` in `./createEventManager` to
// see the call order of the functions here.

// NOTE: Aliasing these and grouping here to make
// future modifications simpler if Event type changes.
type RaycastEvent = MouseEvent | PointerEvent | WheelEvent
type RaycastEventTarget = DomEventTarget
type ThreeEventStub<DomEvent> = Omit<ThreeEvent<DomEvent>, 'eventObject' | 'object' | 'currentTarget' | 'target' | 'distance' | 'point'> & Partial<IntersectionEvent<DomEvent>>
type Object3DWithEvents = Object3D & EventHandlers

function getInitialEvent() {
  // NOTE: Unit tests will without this check
  if (typeof PointerEvent !== 'undefined') {
    return new PointerEvent('pointermove')
  }
  return new MouseEvent('mousemove')
}

type RaycastProps = CreateEventManagerProps<
  Config,
  TresContext,
  RaycastEvent,
  ThreeIntersection,
  Object3D,
  RaycastEventTarget
>
type Config = ReturnType<typeof getInitialConfig>

export interface PointerCaptureTarget {
  event: ThreeEvent<PointerEvent>
  target: Element
}

function getInitialConfig(context: TresContext) {
  return {
    DEBUG: [],
    context,

    isEventsDirty: true,

    raycaster: new Raycaster(),
    // NOTE: Pointer as normalized device coordinates (NDC):
    // x in range (-1, 1), y in range (-1, 1)
    // See: https://threejs.org/docs/#api/en/core/Raycaster
    pointer: new Vector2(0, 0),
    pointerDownPosition: new Vector2(0, 0),

    objectsWithEvents: [] as Object3D[],

    priorIntersections: [] as ThreeIntersection[],
    priorInitialHits: new Set<Object3D>(),
    priorHits: new Set<Object3D>(),

    blockingObjects: new Set<Object3D>(),

    lastMoveEvent: getInitialEvent(),

    pointerToCapturedIntersections: new Map() as Map<number, Set<ThreeIntersection>>,
    pointerToCapturedObjects: new Map() as Map<number, Set<TresObject>>,
    capturableEvent: undefined as ThreeEvent<PointerEvent> | undefined,
  }
}

function stashLastEvent(evt: Event, config: Config) {
  if (evt.type === 'pointermove') {
    config.lastMoveEvent = evt as PointerEvent
  }
}

function getLastEvent(config: Config) {
  return config.lastMoveEvent
}

function connect(target: RaycastEventTarget, eventManagerHandler: (ev: RaycastEvent) => void, config: Config) {
  for (const domEventName of POINTER_EVENT_NAMES) {
    target.addEventListener(domEventName, eventManagerHandler, { passive: DOM_TO_PASSIVE[domEventName] })
  }

  const leave = (pointerEvent: PointerEvent) => handleIntersections(pointerEvent, [], config)
  target.addEventListener('pointerleave', leave, { passive: DOM_TO_PASSIVE.pointerleave })

  return {
    disconnect: () => {
      for (const domEventName of POINTER_EVENT_NAMES) {
        target.removeEventListener(domEventName, eventManagerHandler)
      }
      target.removeEventListener('pointerleave', leave)
    },
  }
}

function setUp(event: RaycastEvent, config: Config) {
  config.pointer.set(
    (event.offsetX / config.context.sizes.width.value) * 2 - 1,
    -(event.offsetY / config.context.sizes.height.value) * 2 + 1,
  )
  if (config.context.camera.value) {
    config.raycaster.setFromCamera(config.pointer, config.context.camera.value)
  }
}

function isSetUp(config: Config) {
  return !!(config.raycaster.camera)
}

function tearDown(config: Config) {
  // @ts-expect-error - Type does not accept the default `null` value.
  config.raycaster.camera = null
}

function getIntersectionsPool(_event: RaycastEvent, config: Config) {
  // NOTE: Perf
  //
  // This function:
  // - gathers and returns the objects that require hit-testing
  // - writes down a few `config` properites to later bail out of
  //   processing associated with particular events.
  //
  // Everything set here is to limit the number
  // of hit-tested objects.

  if (config.isEventsDirty) {
    function getIntersectionsPoolRecurHelper(object: Object3DWithEvents, hasEvents: boolean) {
      // NOTE: We don't need to check for events if we're in a tree that `hasEvents`.
      if (!hasEvents) {
        for (const domEventName of DOM_EVENT_NAMES) {
          if (DOM_TO_THREE[domEventName] in object) {
            hasEvents = true
            break
          }
        }
      }

      if (object.children) {
        for (const child of object.children) {
          getIntersectionsPoolRecurHelper(child, hasEvents)
        }
      }

      // NOTE: `push`ing after processing children leads to a
      // "children-first" object ordering. This is useful for
      // stopping `@pointermissed`, which doesn't bubble and
      // which can't rely on intersections order or "hits"
      // order, by definition.
      if (hasEvents) { config.objectsWithEvents.push(object) }
    }

    // NOTE: We are here because `config.isEventsDirty === true`.
    // This flag signals that THREE objects have changed in a way
    // that may have altered event handlers.
    //
    // Reset the `config` properties, then recurse through the scene
    // to gather/set appropriate values.

    config.isEventsDirty = false
    config.objectsWithEvents.length = 0
    getIntersectionsPoolRecurHelper(config.context.scene.value, false)
  }

  return config.objectsWithEvents
}

function getIntersections(pool: Object3DWithEvents[], config: Config) {
  return config.raycaster.intersectObjects(pool, false)
}

function insert(_instance: TresObject, config: Config) {
  config.isEventsDirty = true
}

const patchPropDomEventRE = new RegExp(`${THREE_EVENT_NAMES.join('|')}`)
const patchPropDomEventWithUnsupportedModifiersRE = new RegExp(`(${THREE_EVENT_NAMES.join('|')})(Capture|Passive|Once)+`)
let sentUnsupportedEventModifiersWarning = false

function patchProp(instance: TresObject, propName: string, prevValue: any, nextValue: any, config: Config) {
  if (!is.object3D(instance)) { return false }

  propName = deprecatedEventsToNewEvents(propName)

  if (propName === 'blocking') {
    if (nextValue) {
      config.blockingObjects.add(instance as Object3D);
      (instance as TresInstance).__tres.eventCount = 1
    }
    else {
      config.blockingObjects.delete(instance as Object3D)
    }
    return true
  }

  if (!isProd) {
    if (patchPropDomEventWithUnsupportedModifiersRE.test(propName)) {
      if (!sentUnsupportedEventModifiersWarning) {
        sentUnsupportedEventModifiersWarning = true
        useLogger().logWarning(`${propName} contains currently unsupported event modifiers. Handlers will not be called. Please remove. (No further warnings will be logged for event modifiers.)`)
      }
    }
  }

  if (!patchPropDomEventRE.test(propName)) {
    return false
  }

  if (!instance.__tres) { prepareTresInstance(instance, {}, config.context) }
  (instance as TresInstance).__tres.eventCount = 1

  instance[propName] = is.arr(nextValue) ? (event: ThreeEvent<unknown>) => nextValue.forEach(fn => fn(event)) : nextValue

  instance.setPointerCapture = (pointerId: number) => setPointerCapture(pointerId, instance, config)
  instance.releasePointerCapture = (pointerId: number) => releasePointerCapture(pointerId, instance, config)
  instance.hasPointerCapture = (pointerId: number) => hasPointerCapture(pointerId, instance, config) ?? false

  config.isEventsDirty = true

  return true
}

function setPointerCapture(pointerId: number, instance: TresObject, config: Config) {
  if (!config.capturableEvent) {
    // NOTE: If this is called outside of an event handler
    // `config.capturableEvent` will be undefined.
    // Like in the DOM, it should fail silently if
    // the method cannot complete.
    return
  }

  if (!config.pointerToCapturedIntersections.has(pointerId)) {
    config.pointerToCapturedIntersections.set(pointerId, new Set())
  }

  if (!config.pointerToCapturedObjects.has(pointerId)) {
    config.pointerToCapturedObjects.set(pointerId, new Set())
  }

  config.pointerToCapturedIntersections.get(pointerId)!.add({ ...config.capturableEvent })
  config.pointerToCapturedObjects.get(pointerId)!.add(instance)

  // NOTE: call `setPointerCapture` on the actual
  // DOM element e.g. the canvas.
  const maybeDOMElement = config.capturableEvent.nativeEvent?.currentTarget
  if (maybeDOMElement && 'setPointerCapture' in maybeDOMElement && is.fun(maybeDOMElement.setPointerCapture)) {
    maybeDOMElement.setPointerCapture(pointerId)
  }
}

function releasePointerCapture(pointerId: number, instance: TresObject, config: Config) {
  let removedIntersection: ThreeIntersection | null = null

  // NOTE: Delete the event
  if (config.pointerToCapturedIntersections.has(pointerId)) {
    const capturedIntersectionsForPointer = config.pointerToCapturedIntersections.get(pointerId)!
    for (const intersection of capturedIntersectionsForPointer) {
      if (intersection.object === instance) {
        capturedIntersectionsForPointer.delete(intersection)
        removedIntersection = intersection
      }
    }
    if (capturedIntersectionsForPointer.size === 0) {
      config.pointerToCapturedIntersections.delete(pointerId)
    }
  }

  // NOTE: Delete the object
  if (config.pointerToCapturedObjects.has(pointerId)) {
    const capturedObjectsForPointer = config.pointerToCapturedObjects.get(pointerId)!
    capturedObjectsForPointer.delete(instance)

    if (capturedObjectsForPointer.size === 0) {
      config.pointerToCapturedObjects.delete(pointerId)
    }

    if (instance && 'onLostpointercapture' in instance && is.fun(instance.onLostpointercapture)) {
      const object = removedIntersection!.object
      instance.onLostpointercapture(
        Object.assign(
          removedIntersection!,
          {
            type: 'lostpointercapture',
            eventObject: object,
            currentTarget: object,
            target: object,
            stopPropagation: () => {},
            preventDefault: () => {},
            stopped: false,
          },
        ),
      )
    }
  }

  // NOTE: If no objects are still capturing, release the DOM element
  if (!config.pointerToCapturedObjects.get(pointerId)) {
    const maybeDomElement = removedIntersection?.nativeEvent?.currentTarget
    if (maybeDomElement && 'releasePointerCapture' in maybeDomElement && is.fun(maybeDomElement.releasePointerCapture)) {
      maybeDomElement.releasePointerCapture(pointerId)
    }
  }
}

function hasPointerCapture(pointerId: number, instance: TresObject, config: Config) {
  return config.pointerToCapturedObjects.get(pointerId)?.has(instance)
}

function remove(instance: TresObject, config: Config) {
  if (!instance.isObject3D) { return }

  // NOTE: This function will typically be called with an object
  // that's about to be removed. We will only get the top-level
  // object and not the descendants.
  // Grab the object and all descendants.
  const instanceAndDescendants = new Set<Object3D>()
  const children = [instance as Object3D]

  while (children.length) {
    const child = children.pop()
    if (child) {
      instanceAndDescendants.add(child)
      if (is.arr(child.children)) {
        for (const c of child.children) {
          children.push(c)
        }
      }
    }
  }

  config.objectsWithEvents = config.objectsWithEvents.filter(obj => !instanceAndDescendants.has(obj))

  const intersections = config.priorIntersections.filter(intersection => !instanceAndDescendants.has(intersection.object))

  // NOTE: Remove references from pointer capture data
  for (const instance of instanceAndDescendants) {
    for (const [pointerId, objects] of config.pointerToCapturedObjects) {
      for (const object of objects) {
        if (object === instance) { releasePointerCapture(pointerId, object, config) }
      }
    }
  }
  // NOTE: We will call `pointerout` and `pointerleave` if the to-be-removed
  // object was under the mouse. That logic is contained within `handleEvent`.
  // So rehandle the saved event, but without instance and its descendants
  // in `intersections`.
  handleIntersections(getLastEvent(config), intersections, config)

  // NOTE: Remove the remaining traces of the object and descendants
  config.priorHits.delete(instance as Object3D)

  config.isEventsDirty = true
}

function handleIntersections(incomingEvent: RaycastEvent, intersections: ThreeIntersection[], config: Config) {
  // NOTE: STRUCTURE OF THIS FUNCTION BODY
  // 0) Add captured intersections if pointer is captured.
  // 1) Gather `hits`, `hitsEntered` and `hitsLeft`.
  // The `hits` Set typically includes all `intersections`
  // objects and their ancestors.
  // 2) Create an outgoing event "stub" with the fields
  // common to all events handlers will receive.
  // 3) Call event handlers.
  // 4) Release the pointer, if necessary.
  // 5) `null` the event.
  // 6) Save data for next event.

  // NOTE:
  // 0) Add capturing objects' intersections if pointer is captured.
  const HAS_POINTER_CAPTURE = ('pointerId' in incomingEvent && config.pointerToCapturedIntersections.has(incomingEvent.pointerId))
  if (HAS_POINTER_CAPTURE) {
    // NOTE: We want to preserve intersections order and only add
    // capturing objects' intersections if they aren't already
    // present. So check if `intersections` already has the capturing
    // object. And push it if not.
    const objectsInIntersections = new Set(intersections.map(intr => intr.object))
    for (const intersection of config.pointerToCapturedIntersections.get(incomingEvent.pointerId)!) {
      if (!objectsInIntersections.has(intersection.object)) {
        intersections.push(intersection)
      }
    }
  }

  // NOTE:
  // 1) Gather `hits`
  // Traverse up through ancestors of each intersection to
  // populate `hits` and `event.intersections`.
  //
  // The result is the bubble order for events.
  // For graph: gparent => parentA, parentB ; parentA => childA
  // and THREE.Intersections: [childA, parentB]
  // bubble/`hits` order is: [childA, parentA, gparent, parentB]
  //
  // `event.intersections` order is (showing `intersection.eventObject`):
  // [childA, parentA, gparent, parentB, gparent]
  // (assuming all objects have events attached)
  //
  // Blocking
  // We will also watch for "blocking" (solid) objects.
  // To pretend that "blocking" objects don't allow raycasting
  // to continue behind them, we'll stop processing intersections
  // after we see one containing a "blocking" object.
  const hits = new Set<Object3D>()
  const hitsLeft = config.priorHits
  const hitsEntered = new Set<Object3D>()

  const initialHits = new Set<Object3D>()

  const filteredIntersections = []
  const eventIntersections = []

  let obj: TresObject | null = null
  let hasBlockingObject = false
  for (const intersection of intersections) {
    obj = intersection.object
    initialHits.add(obj)
    if (hits.has(obj)) {
      continue
    }
    filteredIntersections.push(intersection)
    while (obj) {
      if (config.blockingObjects.has(obj)) {
        hasBlockingObject = true
      }
      if (obj.__tres?.eventCount) {
        eventIntersections.push({ ...intersection, eventObject: obj })
      }
      if (!hits.has(obj)) {
        hits.add(obj)
        if (hitsLeft.has(obj)) {
          hitsLeft.delete(obj)
        }
        else {
          hitsEntered.add(obj)
        }
      }
      obj = obj.parent
    }
    if (hasBlockingObject) {
      // NOTE: We've found a blocking object.
      // We pretend it's "solid" and doesn't allow
      // raycaster rays to continue "behind it".
      // So we'll stop adding intersections.
      break
    }
  }

  // NOTE:
  // 2) Create the outgoing event "stub".
  // This includes fields that all subsequent
  // event handler calls will need.
  const distance = (incomingEvent.type === 'click' || incomingEvent.type === 'contextmenu' || incomingEvent.type === 'dblclick' || incomingEvent.type === 'pointerup')
    ? Math.sqrt(((incomingEvent.offsetX - config.pointerDownPosition.x) ** 2) + ((incomingEvent.offsetY - config.pointerDownPosition.y) ** 2))
    : 0

  if (incomingEvent.type === 'pointerdown') {
    config.pointerDownPosition.x = incomingEvent.offsetX
    config.pointerDownPosition.y = incomingEvent.offsetY
  }

  const unprojectedPoint = new Vector3(config.pointer.x, config.pointer.y, 0).unproject(config.context.camera.value!)

  const outgoingEvent: ThreeEventStub<typeof incomingEvent> = Object.assign(
    getEventNonFunctionProperties(incomingEvent),
    {
      // NOTE: `currentTarget` on `incomingEvent` is a DOMElement. Not the proper type for `outgoingEvent`.
      currentTarget: undefined,
      intersections: eventIntersections,
      unprojectedPoint,
      pointer: config.pointer,
      delta: distance,
      ray: config.raycaster.ray,
      camera: config.raycaster.camera as TresCamera,
      nativeEvent: incomingEvent,
      // NOTE: If the user has e.g. `@click.prevent`, Vue will
      // call `preventDefault` on this event. That will throw
      // if the method doesn't exist. So add it.
      preventDefault: () => incomingEvent.preventDefault(),
      stopped: false,
      stopPropagation: () => {},
    },
  )

  // NOTE: If a pointer is captured, we *must* fire
  // the captured objects' events. So disallow
  // stopping propagation for Tres events.
  outgoingEvent.stopPropagation = HAS_POINTER_CAPTURE
    ? () => { incomingEvent.stopPropagation() }
    : () => { outgoingEvent.stopped = true; incomingEvent.stopPropagation() }

  if (incomingEvent.type.startsWith('pointer') && !(incomingEvent.type === 'pointerup' || incomingEvent.type === 'pointercancel')) {
    config.capturableEvent = outgoingEvent as ThreeEvent<PointerEvent>
  }

  // NOTE:
  // 3) Propagate the events to handlers.

  // NOTE: Call `pointermissed`.
  // `pointermissed` is not bubbled and cannot be stopped with `stopPropagation`.
  if (incomingEvent.type === 'pointerup') {
    outgoingEvent.stopped = false
    for (const obj of config.objectsWithEvents) {
      if (hits.has(obj)) { continue }
      outgoingEvent.eventObject = obj
      outgoingEvent.object = obj
      // NOTE: All misses are "self" misses: `currentTarget` matches `target`
      outgoingEvent.currentTarget = obj
      outgoingEvent.target = obj
      outgoingEvent.eventObject[DOM_TO_THREE['pointermissed' as DomEventName]]?.(outgoingEvent)
    }
  }

  // NOTE: Call `pointer{leave,enter}`
  if (hitsLeft.size) {
    // NOTE: Propagate `pointerleave`
    // `pointerleave` is not bubbled and cannot be stopped with `stopPropagation`.
    callIntersectionObjectsIf('pointerleave', outgoingEvent, config.priorIntersections, (obj: Object3D) => { return hitsLeft.has(obj) })

    {
    // NOTE: Bubble `pointerout`
    // `pointerout` is bubbled and can be stopped with `stopPropagation`.
      const duplicates = new Set()
      outgoingEvent.stopped = false
      for (const intersection of config.priorIntersections) {
        if (outgoingEvent.stopped) { break }

        let object: TresObject | null = intersection.object
        if (initialHits.has(object) || duplicates.has(object)) { continue }

        // NOTE: An event "is-a" `Intersection`,
        // so copy intersection values to the event.
        Object.assign(outgoingEvent, intersection)
        outgoingEvent.target = object

        while (object && !outgoingEvent.stopped && !duplicates.has(object)) {
          outgoingEvent.eventObject = object
          outgoingEvent.currentTarget = object
          object.onPointerout?.(outgoingEvent)
          duplicates.add(object)
          object = object.parent
        }
      }
    }
  }

  if (hitsEntered.size) {
    callIntersectionObjectsIf('pointerenter', outgoingEvent, intersections, (obj: Object3D) => { return hitsEntered.has(obj) })

    {
    // NOTE: Bubble pointerover
    // `pointerover` is bubbled and can be stopped with `stopPropagation`.
      const duplicates = new Set()
      outgoingEvent.stopped = false
      for (const intersection of filteredIntersections) {
        if (outgoingEvent.stopped) { break }

        let object: TresObject | null = intersection.object
        if (config.priorInitialHits.has(object) || duplicates.has(object)) { continue }

        // NOTE: An event "is-a" `Intersection`,
        // so copy intersection values to the event.
        Object.assign(outgoingEvent, intersection)
        outgoingEvent.target = object

        while (object && !outgoingEvent.stopped && !duplicates.has(object)) {
          outgoingEvent.eventObject = object
          outgoingEvent.currentTarget = object
          object.onPointerover?.(outgoingEvent)
          duplicates.add(object)
          object = object.parent
        }
      }
    }
  }

  // NOTE: Propagate `incomingEvent.type`, e.g.:
  // `click`, `dblclick`, `pointermove`, etc.
  if (incomingEvent.type in DOM_TO_THREE) {
    const duplicates = new Set()

    outgoingEvent.stopped = false

    for (const intersection of outgoingEvent.intersections) {
      if (outgoingEvent.stopped) { break }

      if (duplicates.has(intersection.eventObject)) { continue }
      duplicates.add(intersection.eventObject)

      // NOTE: An event "is-a" `Intersection`,
      // so copy intersection values to the event.
      Object.assign(outgoingEvent, intersection)

      const currentTarget = intersection.eventObject
      outgoingEvent.currentTarget = currentTarget
      outgoingEvent.target = intersection.object

      intersection.eventObject[DOM_TO_THREE[incomingEvent.type as DomEventName]]?.(outgoingEvent)
    }
  }

  // NOTE: 4) Release the pointer, if necessary
  if ((incomingEvent.type === 'pointerup' || incomingEvent.type === 'pointercancel')
    && config.pointerToCapturedObjects.has((incomingEvent as PointerEvent).pointerId)) {
    const pointerId = (incomingEvent as PointerEvent).pointerId
    for (const object of config.pointerToCapturedObjects.get(pointerId)!) {
      releasePointerCapture(pointerId, object, config)
    }
  }

  // NOTE: Setting `capturableEvent` to `undefined` here has the effect
  // of disallowing pointer capture outside of event handlers.
  // This is similar to DOM behavior.
  config.capturableEvent = undefined

  // NOTE: 5) `null` the event
  // Like DOM events, we set this to null after we're done with the event.
  // We reuse events for multiple handlers, changing `currentTarget` and
  // other fields. This keeps us from creating new objects and copying
  // values for every handler call.
  // Users wanting to use an event at a later time should copy the event.
  // @ts-expect-error – not typed for null; doing so would be a pain for users.
  outgoingEvent.currentTarget = null
  // @ts-expect-error – same
  outgoingEvent.eventObject = null
  // @ts-expect-error – same
  outgoingEvent.target = null
  // @ts-expect-error – same
  outgoingEvent.object = null

  // NOTE: 6) Save data for next event
  config.priorIntersections = filteredIntersections
  config.priorInitialHits = initialHits
  config.priorHits = hits
}

function callIntersectionObjectsIf(domEventName: DomEventName, event: ThreeEventStub<MouseEvent>, intersections: ThreeIntersection[], cond: (a: any) => boolean) {
  const duplicates = new Set()
  event.stopped = false

  // NOTE: The events handled here are not "bubbled"
  // They cannot be stopped with `stopPropagation`.

  for (const intersection of intersections) {
    // NOTE: An event "is-a" `Intersection`,
    // so copy intersection values to the event.
    Object.assign(event, intersection)
    let object: Object3DWithEvents | null = intersection.object
    while (object && !duplicates.has(object)) {
      duplicates.add(object)
      if (cond(object)) {
        // NOTE: Non-bubbled events are "self" events
        // so all the following fields are "self"
        event.eventObject = object
        event.currentTarget = object
        event.object = object
        event.target = object
        event.eventObject[DOM_TO_THREE[domEventName]]?.(event)
      }

      object = object.parent
    }
  }
}

function getEventNonFunctionProperties<TEvent>(sourceEvent: TEvent): Properties<TEvent> {
  const destination: Record<string, any> = {}
  // NOTE: Mouse/Pointer Event props aren't enumerable.
  // Copies properties to another object.
  for (const property in sourceEvent) {
    if (!is.fun(sourceEvent[property])) {
      destination[property] = sourceEvent[property]
    }
  }
  return destination as Properties<TEvent>
}

export const eventsRaycast: RaycastProps = {
  connect,
  isSetUp,
  setUp,
  tearDown,
  getIntersectionsPool,
  getIntersections,
  handleIntersections,
  getInitialConfig,
  getInitialEvent,
  stashLastEvent,
  getLastEvent,
  insert,
  remove,
  patchProp,
}