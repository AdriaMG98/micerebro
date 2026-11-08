---
type: aprendizaje
title: "Los borradores esperan al revisor"
description: "Todo lo que guarda un agente nace como borrador y solo el revisor lo promueve a memoria."
status: draft
actualizado: 2026-01-01
---

Un agente guarda con `okf guardar` o con la tool `okf_guardar` y la nota cae aquí, en
`memoria/borradores/`. El revisor (`okf-revisor.mjs`) la valida, la mueve a la carpeta que
le toca según su `type`, la apunta en el `index.md` de esa carpeta y deja una línea en `log.md`.
