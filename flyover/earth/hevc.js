// 新しい Flyover の画像（HEVC の 1 コマ）を、WebCodecs で GPU の専用回路を使って展開し、
// 明るさ（Y）と色（UV を交互に並べたもの）の面にして返す作業用のスレッド。
//
// 受け取るもの: { id, images: [{ config: hvcC の中身, data: コマ（長さ付きの NAL の並び） }], gpu }
// 返すもの: { id, out: [{ w, h, y: Uint8Array(w*h), uv: Uint8Array(ceil(w/2)*ceil(h/2)*2) }], ms }
//           か、展開できなかったとき { id, error }。gpu なら out は [{ w, h, bitmap }]（GPU にある RGB の
//           ImageBitmap。CPU に読み戻すと 1 枚 100 ms ほどかかるので、earth.js が GPU の中で Y と UV に戻す）。
//           gpu が 'frame' なら、展開したコマ（VideoFrame）を RGB にせず、1 枚ずつすぐに { id, part, frame } で送り
//           （gpu-render.js が WebGPU で直接読む。専用回路のコマを抱えたまま次を展開すると詰まることがある）、
//           最後に out を [{ w, h, part }] で返す

// HEIC には色の決め方が入っていない。HEIF の決まり（libheif も同じ）どおり BT.601 のフルレンジ
// として扱う（Chrome は何も言わないと BT.709 のリミテッドレンジとみなし、平均 8 段階ほどずれる）。
// 読み戻すときは Y と UV の値をそのまま返すので、変換はシェーダー（earth.js）でする。GPU のままの画像は、ここで
// 渡す色の決め方でブラウザが RGB にする
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

// 展開器はこのスレッドで 1 つを使い回す（作るのに時間がかかる）。設定が前と同じなら設定し直さない。
// 失敗すると展開器は閉じるので、次は作り直す。出てきたコマは、sink があればそれに渡し、なければ frame に置く
function ready(config) {
  if (!dec || dec.state === 'closed') {
    dec = new VideoDecoder({ output: f => { if (sink) { sink(f); return; } if (frame) frame.close(); frame = f; },
                             error: e => { lastError = e; } });
    lastConfig = null;
  }
  const key = codecString(config) + ':' + config.join(',');
  if (key !== lastConfig) {
    dec.configure({ codec: codecString(config), description: config, colorSpace: COLOR,
                    hardwareAcceleration: 'prefer-hardware' });
    lastConfig = key;
  }
}
function decode(config, data) {
  ready(config);
  frame = null; lastError = null;
  dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
  return dec.flush().then(() => {
    const f = frame;
    frame = null;
    if (!f) throw lastError || new Error('コマが出てこない');
    return f;
  }, e => { throw lastError || e; });
}
let dec = null, frame = null, lastConfig = null, lastError = null, sink = null;

// 続けて展開する（gpu が 'frame' で batch のとき）。画像ごとに flush すると、専用回路の流れが毎回空になるまで待つ。
// 届いたタイルの画像をすぐ decode に入れ（前のタイルの展開を待たない。設定が変わる所も、configure は前の decode の
// あとに順に行われる）、待っている画像がなくなったときだけ flush する（専用回路は最後のコマを、次が来るか flush
// するまで出さないことがある）。出てきたコマは、抱えたまま次を展開すると詰まることがあるので、すぐ { id, part,
// frame } で送り、タイルの全部のコマを送ったら { id, out, ms } で知らせる。どのタイルの何枚目かは、通し番号の
// timestamp で見分ける
const live = new Map();          // timestamp -> { job, part }
let nextTs = 0, flushing = false;
function streamOut(f) {
  const e = live.get(f.timestamp);
  live.delete(f.timestamp);
  if (!e) { f.close(); return; }
  const { job, part } = e, w = f.visibleRect.width, h = f.visibleRect.height;
  job.out[part] = { w, h, part };
  postMessage({ id: job.id, part, frame: f }, [f]);      // 送ると、このスレッドのコマは閉じる
  if (--job.left === 0) postMessage({ id: job.id, out: job.out, ms: { decode: performance.now() - job.t, copy: 0, n: job.out.length } });
}
// 通し番号が upto より前で、まだコマが出ていないタイルを失敗にする（upto がなければ全部）
function streamFail(e, upto = Infinity) {
  const jobs = new Set();
  for (const [ts, v] of live) if (ts < upto) { jobs.add(v.job); live.delete(ts); }
  for (const [ts, v] of live) if (jobs.has(v.job)) live.delete(ts);
  for (const job of jobs) postMessage({ id: job.id, error: String(lastError || e) });
}
// flush を始めた時までに入れた画像は、flush が終われば全部出ているはず。flush の間に届いたタイルはまだ出ていない
// ことがあるので、それはもう 1 回 flush する
function streamFlush() {
  if (flushing || !live.size || !dec || dec.state === 'closed') return;
  flushing = true;
  const upto = nextTs;
  dec.flush().then(() => { flushing = false; streamFail(new Error('コマが出てこない'), upto); streamFlush(); },
                   e => { flushing = false; streamFail(e); });
}
function stream(id, images) {
  const job = { id, out: images.map(() => null), left: images.length, t: performance.now() };
  if (!images.length) { postMessage({ id, out: [], ms: { decode: 0, copy: 0, n: 0 } }); return; }
  try {
    sink = streamOut;
    images.forEach((im, i) => {
      ready(im.config);
      const ts = nextTs++;
      live.set(ts, { job, part: i });
      dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: ts, data: im.data }));
    });
  } catch (e) { streamFail(e); return; }
  // 同じ時に続けて届いたタイルも入れ終えてから flush する
  setTimeout(streamFlush, 0);
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

// このスレッドの中では 1 つずつ順に展開する（並べるときは earth.js がスレッドを増やす）
let queue = Promise.resolve();
onmessage = ({ data: { id, images, gpu, batch } }) => {
  if (gpu === 'frame' && batch) { stream(id, images); return; }
  queue = queue.then(async () => {
    sink = null;
    try {
      const out = [], ms = { decode: 0, copy: 0, n: images.length };   // かかった時間（調べる用）
      for (const im of images) {
        let t = performance.now();
        const frame = await decode(im.config, im.data);
        ms.decode += performance.now() - t;
        t = performance.now();
        if (gpu === 'frame') {
          const w = frame.visibleRect.width, h = frame.visibleRect.height, part = out.length;
          postMessage({ id, part, frame }, [frame]);      // 送ると、このスレッドのコマは閉じる
          out.push({ w, h, part });
          continue;
        }
        try {
          // gpu なら CPU に読み戻さず、GPU にあるままの RGB の画像で返す（earth.js の gpuPlanes で Y と UV にする）
          if (gpu) out.push({ bitmap: await createImageBitmap(frame), w: frame.visibleRect.width, h: frame.visibleRect.height });
          else out.push(await planes(frame));
        } finally { frame.close(); }
        ms.copy += performance.now() - t;
      }
      postMessage({ id, out, ms }, out.flatMap(p => p.bitmap ? [p.bitmap] : p.y ? [p.y.buffer, p.uv.buffer] : []));
    } catch (e) {
      postMessage({ id, error: String(e) });
    }
  });
};
