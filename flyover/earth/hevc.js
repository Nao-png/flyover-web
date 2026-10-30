// 新しい Flyover の画像（HEVC の 1 コマ）を、WebCodecs で GPU の専用回路を使って展開し、
// 明るさ（Y）と色（UV を交互に並べたもの）の面にして返す作業用のスレッド。
//
// 受け取るもの: { id, images: [{ config: hvcC の中身, data: コマ（長さ付きの NAL の並び） }] }
// 返すもの: { id, out: [{ w, h, y: Uint8Array(w*h), uv: Uint8Array(ceil(w/2)*ceil(h/2)*2) }] }
//           か、展開できなかったとき { id, error }

// HEIC には色の決め方が入っていない。HEIF の決まり（libheif も同じ）どおり BT.601 のフルレンジ
// として扱う（Chrome は何も言わないと BT.709 のリミテッドレンジとみなし、平均 8 段階ほどずれる）。
// ここでは Y と UV の値をそのまま返すので、変換はシェーダー（earth.js）でする
const COLOR = { matrix: 'smpte170m', fullRange: true, primaries: 'bt709', transfer: 'iec61966-2-1' };

// hvcC から WebCodecs の codec 文字列を作る（ISO/IEC 14496-15 の付録 E）
function codecString(h) {
  const space = h[1] >> 6, tier = (h[1] >> 5) & 1, idc = h[1] & 31;
  let compat = (h[2] << 24 | h[3] << 16 | h[4] << 8 | h[5]) >>> 0, rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1 | (compat & 1)) >>> 0; compat >>>= 1; }
  const cons = [...h.slice(6, 12)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return ['hvc1', ['', 'A', 'B', 'C'][space] + idc, rev.toString(16).toUpperCase(),
          (tier ? 'H' : 'L') + h[12], ...cons.map(b => b.toString(16).toUpperCase())].join('.');
}

function decode(config, data) {
  return new Promise((resolve, reject) => {
    let frame = null;
    const dec = new VideoDecoder({ output: f => { if (frame) frame.close(); frame = f; }, error: reject });
    dec.configure({ codec: codecString(config), description: config, colorSpace: COLOR,
                    hardwareAcceleration: 'prefer-hardware' });
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
    dec.flush().then(() => {
      dec.close();
      frame ? resolve(frame) : reject(new Error('コマが出てこない'));
    }, reject);
  });
}

// 展開したコマ（NV12 か I420）を、すき間なく詰めた Y と UV（交互）の面にする
async function planes(frame) {
  const w = frame.visibleRect.width, h = frame.visibleRect.height, cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const buf = new Uint8Array(frame.allocationSize());
  const layout = await frame.copyTo(buf);
  const y = new Uint8Array(w * h), uv = new Uint8Array(cw * ch * 2);
  for (let r = 0; r < h; r++) y.set(buf.subarray(layout[0].offset + r * layout[0].stride, layout[0].offset + r * layout[0].stride + w), r * w);
  if (frame.format === 'NV12') {
    for (let r = 0; r < ch; r++) {
      const o = layout[1].offset + r * layout[1].stride;
      uv.set(buf.subarray(o, o + cw * 2), r * cw * 2);
    }
  } else if (frame.format === 'I420') {
    for (let r = 0; r < ch; r++) {
      const u = layout[1].offset + r * layout[1].stride, v = layout[2].offset + r * layout[2].stride;
      for (let c = 0; c < cw; c++) { uv[(r * cw + c) * 2] = buf[u + c]; uv[(r * cw + c) * 2 + 1] = buf[v + c]; }
    }
  } else {
    throw new Error('知らない画素の形 ' + frame.format);
  }
  return { w, h, y, uv };
}

// 1 つずつ順に展開する（専用回路は同時に使える数に限りがある）
let queue = Promise.resolve();
onmessage = ({ data: { id, images } }) => {
  queue = queue.then(async () => {
    try {
      const out = [];
      for (const im of images) {
        const frame = await decode(im.config, im.data);
        try { out.push(await planes(frame)); } finally { frame.close(); }
      }
      postMessage({ id, out }, out.flatMap(p => [p.y.buffer, p.uv.buffer]));
    } catch (e) {
      postMessage({ id, error: String(e) });
    }
  });
};
