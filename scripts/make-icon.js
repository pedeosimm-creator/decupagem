// Gera um .ico simples (32x32, 32bpp BGRA) sem depender de nenhuma lib de
// imagem: um círculo laranja sobre fundo escuro, só pra não ficar com o
// ícone genérico do Electron (que estava sendo confundido com o do
// gerenciador-arquivos). Formato clássico ICO com BITMAPINFOHEADER.
const fs = require('fs');
const path = require('path');

const SIZE = 32;
const BG = [0x14, 0x12, 0x0f]; // #14120f (mesmo tom escuro da tela de revisão)
const FG = [0x2e, 0x8a, 0xe0]; // BGR de #e08a2e (laranja da marca)

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const cx = SIZE / 2 - 0.5;
const cy = SIZE / 2 - 0.5;
const r = SIZE * 0.34;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx;
    const dy = y - cy;
    const inCircle = Math.sqrt(dx * dx + dy * dy) <= r;
    const [b, g, rr] = inCircle ? FG : BG;
    // ICO bitmap data is stored bottom-up
    const row = SIZE - 1 - y;
    const off = (row * SIZE + x) * 4;
    pixels[off + 0] = b;
    pixels[off + 1] = g;
    pixels[off + 2] = rr;
    pixels[off + 3] = 0xff;
  }
}

const andMask = Buffer.alloc(SIZE * (SIZE / 8) * 1, 0); // fully opaque, alpha channel handles it

const bmpHeader = Buffer.alloc(40);
bmpHeader.writeUInt32LE(40, 0); // header size
bmpHeader.writeInt32LE(SIZE, 4); // width
bmpHeader.writeInt32LE(SIZE * 2, 8); // height (xor+and)
bmpHeader.writeUInt16LE(1, 12); // planes
bmpHeader.writeUInt16LE(32, 14); // bit count
bmpHeader.writeUInt32LE(0, 16); // compression
bmpHeader.writeUInt32LE(pixels.length + andMask.length, 20); // image size

const imageData = Buffer.concat([bmpHeader, pixels, andMask]);

const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0);
iconDir.writeUInt16LE(1, 2);
iconDir.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry.writeUInt8(SIZE, 0);
entry.writeUInt8(SIZE, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(imageData.length, 8);
entry.writeUInt32LE(iconDir.length + entry.length, 12);

const ico = Buffer.concat([iconDir, entry, imageData]);
const dest = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, ico);
console.log('Ícone gerado em', dest);
