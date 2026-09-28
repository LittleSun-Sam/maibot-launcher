/*
================================================================================
技术文档：scripts/gen-icons.mjs
职责：生成应用图标资源（PNG + 多帧 ICO），供托盘、窗口、electron-builder 使用。
================================================================================
  为什么需要它：
    原项目 package.json 声明 "icon": "public/image/app.ico"，
    但 public/ 目录**根本不存在** —— 打包时无图标、托盘图标为空。
    这里用纯 Node（zlib + 自写 CRC32）真正生成合法的 PNG/ICO，
    不引入任何图像库依赖，二进制可复现。

  图标画的是什么（第一版不是这个，这里记录为什么换）：
    第一版是「圆角蓝方块 + 两个圆点眼睛 + 一条横杠嘴」。
    问题是这个图形**没有任何辨识度**：16px 下就是"蓝色方块里有两个点"，
    和一堆聊天软件的默认头像长得一样，而且它和阿麦（麦麦）毫无关系。

    现在的图形是**一根麦穗**（麦麦 = 麦）：
      · 一条竖茎 + 三对谷粒 + 顶端一粒，纯白剪影，几何对称
      · 白/蓝对比度足够高，缩到 16px 仍能看出"一株带穗的植物"
      · 自己画的几何形状，没有照搬任何官方 logo

  产物（build/ 目录）：
    icon.ico        （16/24/32/48/64/128/256 共 7 帧，全部为 BMP/DIB 帧）
    icon.png        （512×512，electron-builder 的通用图标）
    icon-16/24/32/48/64/128/256.png
    tray.png        （16×16，托盘用）
    tray@2x.png     （32×32，Electron 会自动为 HiDPI 托盘挑选 @2x）

  ★ ICO 为什么是 BMP 帧而不是 PNG 帧：
    第一版只塞了一帧 256 的 PNG。Windows Vista+ 确实支持 PNG 帧，
    但 NSIS（electron-builder 的安装包）与 rcedit（写 exe 图标）在
    某些版本上会拒绝/读错 PNG 帧，而打包出来的安装包图标是用户
    第一眼看到的东西 —— 这里全部用传统 DIB 帧，兼容性最稳。

  用法：npm run icons  （build:main 前由 prebuild:main 自动调用一次）
================================================================================
*/
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'build');

/* ------------------------------------------------------------------ CRC32 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------- PNG */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * 将 RGBA 像素编码为 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须为 width*height*4
 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  /* 每行前置一个 filter 字节（0 = None） */
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  /* bit depth */
  ihdr[9] = 6;  /* color type: RGBA */
  ihdr[10] = 0; /* compression */
  ihdr[11] = 0; /* filter */
  ihdr[12] = 0; /* interlace */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------- ICO */
/**
 * 把一张 RGBA 位图编码成 ICO 里的一帧（BITMAPINFOHEADER + XOR + AND）。
 *
 * 注意 biHeight 要写 `size * 2`：ICO 的 DIB 帧把 XOR 位图与 AND 掩码
 * 竖着拼在一起，这是 ICO 格式的历史包袱，写成 size 会让资源管理器读错。
 * AND 掩码全 0 即可 —— 真正的透明由 32 位 BGRA 的 alpha 通道表达。
 *
 * @param {number} size 边长
 * @param {Buffer} rgba 长度 size*size*4，行序自上而下
 */
function dibFrame(size, rgba) {
  const maskStride = (((size + 31) >> 5) * 4); /* 1bpp 每行按 4 字节对齐 */
  const maskSize = maskStride * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);            /* biSize */
  header.writeInt32LE(size, 4);           /* biWidth */
  header.writeInt32LE(size * 2, 8);       /* biHeight = XOR + AND */
  header.writeUInt16LE(1, 12);            /* biPlanes */
  header.writeUInt16LE(32, 14);           /* biBitCount */
  header.writeUInt32LE(0, 16);            /* biCompression = BI_RGB */
  header.writeUInt32LE(size * size * 4 + maskSize, 20); /* biSizeImage */
  /* biXPelsPerMeter / biYPelsPerMeter / biClrUsed / biClrImportant 皆为 0 */

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    /* DIB 行序自下而上 */
    const src = (size - 1 - y) * size * 4;
    const dst = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = src + x * 4;
      const d = dst + x * 4;
      xor[d] = rgba[s + 2];     /* B */
      xor[d + 1] = rgba[s + 1]; /* G */
      xor[d + 2] = rgba[s];     /* R */
      xor[d + 3] = rgba[s + 3]; /* A */
    }
  }
  return Buffer.concat([header, xor, Buffer.alloc(maskSize)]);
}

/**
 * 组装多帧 ICO。
 * @param {Array<{size:number, data:Buffer}>} frames
 */
function encodeIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); /* reserved */
  header.writeUInt16LE(1, 2); /* type: icon */
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries = [];
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e[0] = f.size >= 256 ? 0 : f.size; /* 256 用 0 表示 */
    e[1] = f.size >= 256 ? 0 : f.size;
    e[2] = 0; /* 调色板数 */
    e[3] = 0; /* reserved */
    e.writeUInt16LE(1, 4);  /* 色彩平面 */
    e.writeUInt16LE(32, 6); /* 每像素位数 */
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}

/* ---------------------------------------------------------------- 绘制 */
/*
  配色：主题色 #66ccff 做对角线渐变，两端各压暗/提亮一档，
  避免整块纯色显得像色卡。
*/
const GRAD_FROM = [0x7c, 0xdc, 0xff];
const GRAD_TO = [0x2b, 0x8f, 0xd8];
const INK = [0xff, 0xff, 0xff];

/** 点在以 (cx,cy) 为中心、半径 r 的圆内 */
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 点在旋转椭圆内：把点变换到椭圆自身坐标系再判断。
 * @param {number} ang 椭圆长轴与 x 轴夹角（弧度）
 */
function inEllipse(x, y, cx, cy, a, b, ang) {
  const dx = x - cx;
  const dy = y - cy;
  const c = Math.cos(-ang);
  const s = Math.sin(-ang);
  const u = dx * c - dy * s;
  const v = dx * s + dy * c;
  return (u * u) / (a * a) + (v * v) / (b * b) <= 1;
}

/** 点是否落在尺寸 S、圆角半径 r 的圆角矩形内（覆盖整张画布） */
function inSquircle(x, y, S, r) {
  const lo = r;
  const hi = S - 1 - r;
  if (x < 0 || x > S - 1 || y < 0 || y > S - 1) return false;
  const cx = x < lo ? lo : x > hi ? hi : x;
  const cy = y < lo ? lo : y > hi ? hi : y;
  if (cx === x && cy === y) return true;
  return inCircle(x, y, cx, cy, r);
}

/**
 * 麦穗剪影：一根竖茎 + 三对谷粒 + 顶端一粒。
 * 全部用**归一化坐标**（0~1 相对于画布边长）描述，再乘回 S，
 * 这样任何一个尺寸画出来的都是同一株麦穗，不会在大尺寸下变大头。
 * @param {number} x 画布内像素坐标（0..S）
 * @param {number} y
 * @param {number} S 画布边长
 * @returns {boolean}
 */
function inWheatEar(x, y, S) {
  const px = x / S;
  const py = y / S;

  /*
    茎要**细**（半宽 0.016）。
    第一版茎半宽 0.042、谷粒又大，结果谷粒和茎糊成一大团，
    大尺寸下像一片树叶、16px 下就是一个白方块 —— 完全没有"穗"的结构。
  */
  const stemHalf = 0.016;
  const stemTop = 0.34;
  const stemBottom = 0.845;
  if (px >= 0.5 - stemHalf && px <= 0.5 + stemHalf) {
    if (py >= stemTop && py <= stemBottom) return true;
    const capY = py < stemTop ? stemTop : stemBottom;
    if (Math.abs(py - capY) <= stemHalf) {
      return inEllipse(px, py, 0.5, capY, stemHalf, stemHalf, 0);
    }
  }

  /*
    谷粒：四层，自下而上；每粒从茎上"斜着往外上方长"。
    几何关系（右侧为例，θ = 0.56 rad ≈ 32°）：
      长轴方向 (cosθ, -sinθ)，谷粒内端贴在茎边 x = 0.5 + stemHalf，
      于是中心 = 内端 + a·(cosθ, -sinθ)。
    这样谷粒是"从茎上长出来"的，而不是一堆椭圆浮在旁边。
    层间距 0.115 略小于谷粒的竖直跨度 0.136 —— 刻意留一点瓦片式叠压，
    既像真麦穗，又不会糊成实心（第一版就是糊了）。
  */
  const ANG = 0.56;
  const cosA = Math.cos(ANG);
  const sinA = Math.sin(ANG);
  const grains = [
    { y0: 0.720, a: 0.105, b: 0.046 },
    { y0: 0.605, a: 0.103, b: 0.045 },
    { y0: 0.490, a: 0.097, b: 0.043 },
    { y0: 0.375, a: 0.088, b: 0.040 }
  ];
  for (const g of grains) {
    for (const side of [-1, 1]) {
      const innerX = 0.5 + side * stemHalf;
      const cx = innerX + side * g.a * cosA;
      const cy = g.y0 - g.a * sinA;
      const ang = side > 0 ? -ANG : ANG;
      if (inEllipse(px, py, cx, cy, g.a, g.b, ang)) return true;
    }
  }

  /*
    顶端一粒：立着收尖。
    位置/尺寸和第二版不同：第二版它偏上又偏窄，底部和顶对谷粒的内端
    之间留下一个"v"形缺口（256px 下看得很清楚，像图标破了个洞）。
    现在加宽到 a=0.058 并下移 0.007，正好盖住那对谷粒的内端。
  */
  if (inEllipse(px, py, 0.5, 0.312, 0.058, 0.092, 0)) return true;

  return false;
}

/**
 * 绘制图标：圆角方块 + 对角线渐变底 + 白色麦穗剪影。
 * 超采样 4× 后做盒式降采样，得到平滑边缘（不依赖任何绘图库）。
 * @param {number} size
 * @returns {Buffer} RGBA
 */
function drawIcon(size) {
  const SS = 4;
  const S = size * SS;
  const radius = S * 0.235;
  const acc = new Float64Array(size * size * 4);

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (inSquircle(x, y, S, radius)) {
        /* 对角线渐变：左上亮、右下沉 */
        const t = Math.min(1, Math.max(0, (x / S) * 0.45 + (y / S) * 0.55));
        r = GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t;
        g = GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t;
        b = GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t;
        a = 255;

        /* 极淡的高光，让纯色块有点体积感（alpha 上限 0.08，肉眼只觉"不平"） */
        const hx = x / S - 0.28;
        const hy = y / S - 0.28;
        const hl = Math.max(0, 1 - (hx * hx + hy * hy) / 0.22) * 0.08;
        if (hl > 0) {
          r += (255 - r) * hl;
          g += (255 - g) * hl;
          b += (255 - b) * hl;
        }

        if (inWheatEar(x, y, S)) {
          r = INK[0];
          g = INK[1];
          b = INK[2];
        }
      }

      const dx = Math.floor(x / SS);
      const dy = Math.floor(y / SS);
      const idx = (dy * size + dx) * 4;
      acc[idx] += r;
      acc[idx + 1] += g;
      acc[idx + 2] += b;
      acc[idx + 3] += a;
    }
  }

  const n = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = Math.round(acc[i * 4] / n);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return out;
}

/* ------------------------------------------------------------------ main */
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pngs = {};
  for (const size of PNG_SIZES) {
    const png = encodePng(size, size, drawIcon(size));
    pngs[size] = png;
    const file = path.join(OUT_DIR, `icon-${size}.png`);
    fs.writeFileSync(file, png);
    console.log(`[icons] ${path.relative(ROOT, file)} (${size}×${size}, ${png.length} B)`);
  }

  /*
    通用图标名 icon.png：electron-builder 在没有 platform 专属图标时用它，
    Linux/macOS 也读它。给 512 的那张。
  */
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngs[512]);
  console.log(`[icons] build/icon.png (512×512, ${pngs[512].length} B)`);

  /*
    ICO 帧：小尺寸用 16/24/32/48，大尺寸给到 256。
    少了 24 与 48，Windows 在"中等图标"视图下会拿 32 硬放大，边缘发糊。
  */
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = icoSizes.map((size) => ({ size, data: dibFrame(size, drawIcon(size)) }));
  const ico = encodeIco(frames);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(
    `[icons] build/icon.ico (${icoSizes.join('/')} 共 ${frames.length} 帧, ${ico.length} B)`
  );

  /* 托盘：16 给 100% 缩放，@2x 给 200%（Electron 会自己挑同名 @2x） */
  fs.writeFileSync(path.join(OUT_DIR, 'tray.png'), pngs[16]);
  fs.writeFileSync(path.join(OUT_DIR, 'tray@2x.png'), pngs[32]);
  console.log('[icons] build/tray.png (16×16) + build/tray@2x.png (32×32)');
}

main();
