# Frosthold Launcher

Launcher de escritorio para el reino Frosthold (parche 3.3.5a). Descarga y
verifica el cliente, configura el realmlist y abre el juego.

## Cómo funciona

El launcher **no decide** qué archivos existen: lee un manifiesto publicado en
`avsolem.com/wow/manifest.json` con la lista completa, cada uno con su tamaño,
su SHA-256 y su URL. Compara contra el disco y baja solo lo que falta.

Ese manifiesto lo genera `scripts/build-manifest.mjs` a partir del manifiesto
del origen, aplicando las reglas de `frosthold.config.json`: se excluye el
`realmlist.wtf` del origen (lo escribe el launcher con nuestro host), se
excluye su parche de marca, y su ejecutable se guarda como `Frosthold.exe`.

Se genera **a mano**, no en vivo. Si el origen republica su manifiesto, el
nuestro no cambia hasta que alguien lo regenere y revise el informe. Un
manifiesto que se mueve solo es un launcher cuyo comportamiento no controlas.

## Comandos

```bash
yarn install
yarn manifest          # genera dist-manifest/manifest.json
yarn manifest --check  # además comprueba que una muestra de URLs responde
yarn build             # compila TypeScript a dist/
yarn dev               # compila y abre el launcher
yarn dist              # empaqueta el instalador NSIS en release/
node scripts/test-downloads.mjs   # prueba el motor contra el CDN real
```

## Estructura

```
scripts/build-manifest.mjs   generador del manifiesto
scripts/test-downloads.mjs   pruebas del motor de descargas
src/main/download-manager.ts motor: reanudación, reintentos, SHA-256
src/main/install-manager.ts  realmlist, respaldos del WTF, espacio en disco
src/main/process-manager.ts  arranque del juego
src/main/status-manager.ts   estado del reino desde la API del sitio
src/preload/index.ts         puente aislado hacia la interfaz
src/renderer/                interfaz (HTML, CSS y JS sin dependencias)
frosthold.config.json        host del realmlist, rutas y reglas del manifiesto
```

## Decisiones que conviene no deshacer

**El registro de lo instalado.** Verificar 16,5 GB por hash tarda minutos.
Tras verificar un archivo se guarda su tamaño y su fecha en
`<juego>/.frosthold/installed.json`; en arranques siguientes solo se rehashea
lo que cambió. La verificación completa existe, pero es una acción explícita.

**El respaldo antes de tocar el realmlist.** La carpeta `WTF` guarda cuentas,
ajustes y macros del jugador. Se copia antes de escribir, con rotación de 5.

**`cwd` al lanzar el juego.** El cliente busca `Data/` y `WTF/` relativos al
directorio de trabajo, no a la ubicación del ejecutable.

## Pendiente

- Firma de código. Sin certificado, Windows muestra el aviso de SmartScreen en
  cada instalación (200-400 USD/año).
- Publicar `manifest.json` y el canal de actualizaciones en el sitio.
- Parche propio de pantalla de inicio y logotipos (MPQ, con StormLib).
- Soporte de Linux y macOS vía Wine.
