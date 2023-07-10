# Extend 🔌

TresJs se ofrece funcionalidad esencial, pero es fácil añadir elementos externos y extenderles en tu catálogo interno.

Muchas de las experiencias 3D usa `OrbitControls` que no es una parte de la biblioteca core en Threejs. Puedes añadirlo importando lo directamente desde `three/addons/controls/OrbitControls`

```js
import { OrbitControls } from 'three/addons/controls/OrbitControls'
```

## Extender un elemento de forma dinámica

```vue {2,3,4,7,13,15}
<script setup lang="ts">
import { extend } from '@tresjs/core'
import { OrbitControls } from 'three/addons/controls/OrbitControls'
import { TextGeometry } from 'three/addons/geometries/TextGeometry'

// Add the element to the catalogue
extend({ TextGeometry, OrbitControls })
</script>

<template>
  <TresCanvas shadows alpha>
    <TresPerspectiveCamera :position="[5, 5, 5]" />
    <TresOrbitControls v-if="state.renderer" :args="[state.camera, state.renderer?.domElement]" />
    <TresMesh>
      <TresTextGeometry :args="['TresJS', { font, ...fontOptions }]" center />
      <TresMeshMatcapMaterial :matcap="matcapTexture" />
    </TresMesh>
  </TresCanvas>
</template>
```
