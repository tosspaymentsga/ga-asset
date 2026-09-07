/**
 * 최소 QR 인코더 (테스트 전용).
 *
 * 실제 QR 이미지를 만들어 벤더링한 jsQR 이 정말로 디코딩하는지 검증하기 위한 도구다.
 * 배포물에는 포함되지 않는다.
 *
 * 지원 범위: 버전 1~4, EC 레벨 L, 바이트 모드 (자산 Tag 문자열이면 충분)
 */
'use strict';

const zlib = require('zlib');

/* ---------------- GF(256) 산술 ---------------- */
const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 생성 다항식 */
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data, ecCount) {
  const gen = generatorPoly(ecCount);
  const res = new Array(ecCount).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

/* ---------------- 버전 정보 (EC 레벨 L, 블록 1개) ---------------- */
const VERSIONS = {
  1: { size: 21, total: 26, dataCodewords: 19, ecCodewords: 7, align: [] },
  2: { size: 25, total: 44, dataCodewords: 34, ecCodewords: 10, align: [6, 18] },
  3: { size: 29, total: 70, dataCodewords: 55, ecCodewords: 15, align: [6, 22] },
  4: { size: 33, total: 100, dataCodewords: 80, ecCodewords: 20, align: [6, 26] },
};

function pickVersion(byteLength) {
  for (const v of [1, 2, 3, 4]) {
    // 모드(4) + 문자수(8) + 데이터(8n) + 종단자(4) 가 데이터 코드워드 안에 들어가야 한다
    const bits = 4 + 8 + byteLength * 8;
    if (bits + 4 <= VERSIONS[v].dataCodewords * 8) return v;
  }
  throw new Error('지원 범위를 넘는 데이터 길이입니다 (버전 1~4).');
}

/* ---------------- 비트 스트림 ---------------- */
class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      bytes.push(b);
    }
    return bytes;
  }
}

/* ---------------- 매트릭스 구성 ---------------- */
function createMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[rr][cc] = inRing ? 1 : 0;
    }
  }
}

function placeAlignment(m, centers) {
  if (!centers.length) return;
  const size = m.length;
  for (const r of centers) {
    for (const c of centers) {
      // 파인더 패턴과 겹치는 위치는 건너뛴다
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = ring === 1 ? 0 : 1;
        }
      }
    }
  }
}

function placeTiming(m) {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = v;
    if (m[i][6] === null) m[i][6] = v;
  }
}

function reserveFormat(m) {
  const size = m.length;
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }
  m[size - 8][8] = 1; // dark module
}

function maskFn(pattern, r, c) {
  switch (pattern) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function formatBits(ecLevelBits, mask) {
  let data = (ecLevelBits << 3) | mask;
  let value = data << 10;
  const g = 0x537;
  for (let i = 4; i >= 0; i--) {
    if (value & (1 << (i + 10))) value ^= g << i;
  }
  return ((data << 10) | value) ^ 0x5412;
}

function placeFormat(m, mask) {
  const size = m.length;
  const bits = formatBits(0b01, mask); // EC 레벨 L

  // ISO/IEC 18004 형식정보 배치 (비트 0 이 LSB)
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;

    // 사본 1: 좌측 세로
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;

    // 사본 2: 상단 가로
    if (i < 8) m[8][size - 1 - i] = bit;
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;
  }

  m[size - 8][8] = 1; // dark module
}

function isFunctionModule(reserved, r, c) {
  return reserved[r][c] !== null;
}

/** 문자열 → QR 모듈 매트릭스 (true = 검정) */
function encodeQr(text, options = {}) {
  const mask = options.mask === undefined ? 2 : options.mask;
  const bytes = Buffer.from(text, 'utf8');
  const version = pickVersion(bytes.length);
  const spec = VERSIONS[version];

  // 1) 비트 스트림
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // 바이트 모드
  buf.put(bytes.length, 8); // 버전 1~9 문자수 지시자
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = spec.dataCodewords * 8;
  const terminator = Math.min(4, capacityBits - buf.length);
  buf.put(0, terminator);
  while (buf.length % 8 !== 0) buf.put(0, 1);

  const dataBytes = buf.toBytes();
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (dataBytes.length < spec.dataCodewords) {
    dataBytes.push(padBytes[padIndex++ % 2]);
  }

  // 2) 오류정정
  const ec = reedSolomon(dataBytes, spec.ecCodewords);
  const codewords = dataBytes.concat(ec);

  // 3) 기능 패턴
  const size = spec.size;
  const m = createMatrix(size);
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  placeAlignment(m, spec.align);
  placeTiming(m);
  reserveFormat(m);
  const reserved = m.map((row) => row.slice());

  // 4) 데이터 배치 (우하단부터 지그재그)
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i) => (codewords[i >> 3] >> (7 - (i & 7))) & 1;

  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 세로 타이밍 패턴 열 건너뛰기
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (isFunctionModule(reserved, row, c)) continue;
        let bit = bitIndex < totalBits ? bitAt(bitIndex) : 0;
        bitIndex++;
        if (maskFn(mask, row, c)) bit ^= 1;
        m[row][c] = bit;
      }
    }
    upward = !upward;
  }

  placeFormat(m, mask);
  return m.map((row) => row.map((v) => v === 1));
}

/* ---------------- PNG 출력 ---------------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 모듈 매트릭스 → 회색조 PNG Buffer */
function matrixToPng(matrix, scale = 8, quiet = 4) {
  const modules = matrix.length;
  const size = (modules + quiet * 2) * scale;

  const raw = Buffer.alloc((size + 1) * size, 0xff);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // 필터 타입
  }
  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < modules; mx++) {
      if (!matrix[my][mx]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const y = (my + quiet) * scale + dy;
        const rowStart = y * (size + 1) + 1;
        const xStart = (mx + quiet) * scale;
        raw.fill(0x00, rowStart + xStart, rowStart + xStart + scale);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 매트릭스 → jsQR 이 받는 RGBA ImageData 형태 */
function matrixToRgba(matrix, scale = 8, quiet = 4) {
  const modules = matrix.length;
  const size = (modules + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < modules; mx++) {
      if (!matrix[my][mx]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (my + quiet) * scale + dy;
          const x = (mx + quiet) * scale + dx;
          const i = (y * size + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

module.exports = { encodeQr, matrixToPng, matrixToRgba };
