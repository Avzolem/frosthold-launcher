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
yarn test              # las cuatro baterías de pruebas
```

### Pruebas

| Batería | Qué cubre | Necesita red |
| --- | --- | --- |
| `test-downloads.mjs` | descarga, verificación y reanudación contra el CDN real | sí |
| `test-download-edge.mjs` | rangos rechazados, servidores que los ignoran, cortes a mitad, disco que no admite escritura, detener y reanudar | no (servidor local) |
| `test-install-checks.mjs` | carpetas protegidas de Windows, espacio, permisos, realmlist, juego ya abierto, mensajes de error, coherencia del manifiesto | no |
| `test-graphics-reset.mjs` | restablecer gráficos sin tocar teclas, sonido ni cuenta | no |

### Ayudas para revisar la interfaz

```bash
yarn build
SHOT_PATH=/tmp/shot.png ./node_modules/electron/dist/electron . --screenshot --no-sandbox

FROSTHOLD_FAKE_UPDATE=ready|downloading|error   # aviso de versión nueva
FROSTHOLD_FAKE_STATUS=reciente|vieja|caduca|sin # edad del dato del reino
--window-size=780x470                           # pantalla pequeña o escalado al 150 %
```

## Estructura

```
scripts/build-manifest.mjs   generador del manifiesto y su comprobación
scripts/test-*.mjs           las cuatro baterías de pruebas
src/main/download-manager.ts motor: reanudación, reintentos, SHA-256
src/main/install-manager.ts  realmlist, respaldos del WTF, veredicto de la carpeta
src/main/process-manager.ts  arranque del juego y detección de que ya está abierto
src/main/status-manager.ts   estado del reino, con la edad del dato
src/main/net-errors.ts       fallos de red y de disco en lenguaje llano
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

**El realmlist se escribe en TODAS las carpetas de idioma.** Quien reutiliza un
cliente que ya tenía puede acabar con dos idiomas dentro de `Data`, y entonces
cuál manda lo decide `SET locale` de `Config.wtf`, no nosotros. Escribir solo en
`esMX` dejaba a esa persona mirando la lista de reinos de otro servidor sin una
sola pista de por qué.

**El realmlist NO puede estar en el manifiesto.** Si se colara, el launcher lo
bajaría, lo reescribiría con nuestro host al arrancar el juego, y en la
comprobación siguiente el hash ya no cuadraría: lo daría por dañado y lo
volvería a bajar, sin fin. `revisarCoherencia` en `build-manifest.mjs` lo
comprueba antes de publicar, y hay una prueba que lo fija.

**La carpeta se examina antes de bajar nada.** Permisos de verdad (escribiendo
un archivo, no preguntando por `access`: en Windows miente), espacio libre con
cifras, y rechazo de `Archivos de programa`, `ProgramData`, `Windows`, `AppData`
y `OneDrive`. Descubrir a las tres horas de descarga que la carpeta no valía es
el peor momento posible.

**Los fallos de disco no se reintentan.** Un disco lleno no se vacía entre
intento e intento. Se corta la descarga entera, se dice qué pasó y se conserva
lo bajado; cuatro reintentos por cada uno de los 141 archivos solo alargan la
agonía.

**«Sin dato» no es «caído».** El estado del reino se sirve con su edad a la
vista: por encima de tres minutos se declara viejo, y por encima de media hora
se deja de servir la cifra en vez de servirla con una nota al pie. Nunca se
pinta un cero donde no hubo lectura.

## Procedencia de los recursos gráficos

`src/renderer/assets/` contiene arte que **no es original de este proyecto**:

- `play*.png` y `btn*.png` son los botones del launcher clásico de World of
  Warcraft, en su variante de Wrath of the Lich King. Son obra de Blizzard
  Entertainment.
- `backdrop.jpg` es arte promocional de Wrath of the Lich King, también de
  Blizzard, con el logotipo de la expansión retirado.

Frosthold es un reino privado sin ánimo de lucro: no cobra por jugar, no tiene
tienda y no acepta donaciones. Aun así, conviene que quede escrito y no
sobreentendido: World of Warcraft, Wrath of the Lich King y todo el material
gráfico asociado son marcas y obra de Blizzard Entertainment, Inc. Este
proyecto no está afiliado a Blizzard ni cuenta con su respaldo.

Quien reutilice este repositorio debería sustituir esos archivos por arte
propio. El resto de la interfaz —marcos, tipografía, disposición— sí está
hecho aquí y no depende de ellos.

## Pendiente

- Firma de código. Sin certificado, Windows muestra el aviso de SmartScreen en
  cada instalación (200-400 USD/año).
- Publicar `manifest.json` y el canal de actualizaciones en el sitio.
- Parche propio de pantalla de inicio y logotipos (MPQ, con StormLib).
- Soporte de Linux y macOS vía Wine.
