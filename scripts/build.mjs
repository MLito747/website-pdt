import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../public/vendor/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../node_modules/qrcode-generator/dist/qrcode.js", import.meta.url),
  new URL("../public/vendor/qrcode.js", import.meta.url),
);
await copyFile(
  new URL("../licenses/qrcode-generator-MIT.txt", import.meta.url),
  new URL("../public/vendor/qrcode-LICENSE.txt", import.meta.url),
);
