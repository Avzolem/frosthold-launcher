// Electron empaqueta ~55 archivos de idioma de Chromium. El launcher solo
// habla español e inglés; el resto son unos 9 MB que nadie va a leer.
const { readdir, rm, stat } = require('node:fs/promises');
const { join } = require('node:path');

const KEEP = new Set(['es.pak', 'es-419.pak', 'en-US.pak']);

exports.default = async function afterPack(context) {
  const dir = join(context.appOutDir, 'locales');
  let removed = 0;
  let bytes = 0;

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return; // en algunas plataformas no existe esa carpeta
  }

  for (const name of entries) {
    if (!name.endsWith('.pak') || KEEP.has(name)) continue;
    const p = join(dir, name);
    bytes += (await stat(p)).size;
    await rm(p, { force: true });
    removed++;
  }

  console.log(
    `  • idiomas: ${removed} archivos fuera, ${(bytes / 1048576).toFixed(1)} MB menos`
  );
};
