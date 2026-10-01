# Uso seguro de los scripts de carga

Estos artefactos fueron preparados para **staging aislado**; no se ejecutaron durante la auditoría.

## Requisitos de staging

- Copia separada de PostgreSQL con las 628 unidades y coeficientes de prueba que sumen exactamente 100.000000.
- Servicio de staging que no use el secreto ni la URL de ribera-db.
- Asamblea activa, pregunta activa sin votos previos y opción válida.
- 628 JWT de residentes de staging distintos, uno por unidad, más un JWT de administrador de staging para leer quórum.
- Archivo JSON de credenciales de prueba guardado fuera del repositorio y sin nombres, teléfonos ni datos reales. No usar el CSV de enlaces a propietarios.
- Pregunta nueva o snapshot restaurado antes de cada corrida: los votos son inmutables.

Estructura del archivo JSON privado:

    {
      "adminToken": "JWT-DE-STAGING",
      "residents": [
        {
          "id_unidad": "UUID-DE-UNIDAD",
          "coeficiente": "0.123456",
          "token": "JWT-DE-ESA-UNIDAD"
        }
      ]
    }

Debe tener 628 filas; cada token debe corresponder a su unidad y asamblea. Los scripts inspeccionan claims localmente y el servidor valida la firma. No imprimen los tokens.

## Prueba HTTP con k6

En PowerShell, define el host de staging, el archivo privado y la configuración de ballot. El marcador explícito evita iniciar la prueba por error.

    $env:LOADTEST_CONFIRM_STAGING = 'I_CONFIRM_ISOLATED_STAGING'
    $env:TARGET_URL = 'https://TU-SERVICIO-STAGING'
    $env:LOADTEST_USERS_FILE = 'C:\ruta-privada\staging-voters.json'
    $env:ASSEMBLY_ID = 'UUID-ASAMBLEA-STAGING'
    $env:QUESTION_ID = 'ID-PREGUNTA-ACTIVA'
    $env:OPTION_ID = 'ID-OPCION-VALIDA'
    k6 run .\outputs\auditoria-asamblea-futuro\load-votes-628.js

k6 crea 628 VUs, una solicitud de voto por unidad, valida HTTP 201 y consulta al final que el conteo sea 628 y la suma exacta 100.000000. Cada corrida consume la pregunta (votos inmutables).

## Prueba de conexiones y sufragios Socket.IO

El script Node usa el socket.io-client instalado en el proyecto y emite un voto simultáneo por cada una de las 628 unidades:

    $env:LOADTEST_CONFIRM_STAGING = 'I_CONFIRM_ISOLATED_STAGING'
    $env:TARGET_URL = 'https://TU-SERVICIO-STAGING'
    $env:LOADTEST_USERS_FILE = 'C:\ruta-privada\staging-voters.json'
    $env:LOADTEST_PROJECT_ROOT = 'C:\Users\Juan Ramirez\Documents\Codex\2026-09-29\rea\outputs'
    $env:ASSEMBLY_ID = 'UUID-ASAMBLEA-STAGING'
    $env:QUESTION_ID = 'ID-PREGUNTA-ACTIVA'
    $env:OPTION_ID = 'ID-OPCION-VALIDA'
    node .\outputs\auditoria-asamblea-futuro\socketio-vote-628.mjs

La herramienta bloquea los dos dominios públicos de producción conocidos. No quites esa protección. El script verifica ACK, latencias p95/p99, conteo y suma decimal final; el dato RSS que imprime corresponde al generador de carga local, no al servidor.

## Observación durante la corrida

Antes, durante y después, abrir en Render las métricas de Web Service y Postgres. Capturar CPU/RAM del Web Service, tráfico WebSocket, volumen/latencia HTTP si está disponible, conexiones activas de Postgres, queries demoradas por lock y top queries. Correlacionar con hora del test y commit SHA. No lanzar una carga de este tamaño contra producción: los sufragios quedan persistidos y son inmutables.
