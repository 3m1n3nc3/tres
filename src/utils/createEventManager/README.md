# createEventManager

The files in this directory work together to create an `EventManager`. There are 3 main parts:

## createEventManager.ts

`createEventManager` handles state creation/management, ordering of method calls and exporting of the user API. Start here to get an overview of how `EventManager` works.

## eventsRaycast.ts

This file exports the default configuration for the event system: an object composed of methods called by `EventManager`. `EventManager` passes state into the methods; they hold no state themselves (at the time of this writing).

Hittesting and event propagation is implemented in this file.

### eventsNoop.ts

This file exports an object of the same type as exported by `eventsRaycast.ts` (though with the generics filled in differently) as `events`. It's loaded when the user specifies that they don't want to use the event system.

## useEventsOptions.ts

This file implements the reactive elements of `EventManager`. `EventManager` itself is not reactive, but can be made to respond to changing user props via `useEventsProps()`.