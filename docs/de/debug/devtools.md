# Entwicklungstools

Eine der größten Herausforderungen, denen sich ein Entwickler beim Erstellen von 3D-Erlebnissen im Browser gegenübersieht, ist das Debugging. Das `canvas` des Browsers ist eine Blackbox, und es ist schwierig zu wissen, was darin vor sich geht. Die imperative Natur von [Three.js](https://threejs.org/) macht es unglaublich schwierig zu debuggen, wobei man sich auf `console.log` verlassen muss, um zu sehen, was passiert, oder auf Drittanbieter-Tools, um die Szene anzupassen und zu inspizieren.

Fang gar nicht erst damit an, die Performance deiner Szene zu überprüfen. 😱

![desarrollador depurando 3D](/debug-3D.png)

Eines unserer Ziele mit TresJS ist es, **die beste Entwicklererfahrung (DX)** beim Arbeiten mit 3D-Szenen im Browser zu bieten. Dank der deklarativen Natur des Ökosystems und der Vielfalt an Lösungen, die das Vue-Ökosystem bietet, wie Vue Devtools, Nuxt und Vite, können wir bessere Tools für Entwickler anbieten, um ihre Szenen zu debuggen.

## Vorstellung der Entwicklerwerkzeuge

Ab Version <Badge text="^3.7.0" />, führen wir die TresJS-Entwicklerwerkzeuge ein, eine benutzerdefinierte Inspektor-Tab für die [offiziellen Chrome Developer Tools von Vue](https://devtools.vuejs.org/guide/installation.html), die es dir ermöglicht, deine TresJS-Szenen und -Komponenten zu inspizieren.

![Herramientas de Desarrollo de TresJS](/vue-chrome-devtools.png)

### Funktionen

- **Szeneninspektor**: Inspiziere die aktuelle Szene und ihre Komponenten mit einer Baumansicht ähnlich dem Komponenteninspektor von Vue Devtools.
- **Speicherzuweisung**: Zeigt an, wie viel Speicher jede Komponente verwendet.
- **Objektinspektor**: Inspiziere die Eigenschaften des in der Szene ausgewählten Objekts, einschließlich seiner Kinder.
- **Editierbare Eigenschaften**: Und ja, du kannst die Eigenschaften des ausgewählten Objekts bearbeiten und die Änderungen in Echtzeit sehen.

![](/devtools-scene-inspector.png)

Genieße die neuen Entwicklerwerkzeuge und lass uns wissen, was du denkst! 🎉