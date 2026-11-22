// WebGPU 版のビューア（gpu.html）の光のにじみ（ブルーム）。描き終えた画面から明るい所だけを取り出し、縦横半分ずつ
// 6 段まで縮めながらぼかし、大きい段へ順に足し戻して、元の画面に足す。夜景の窓の明かりのまわりがやわらかく光る。
// 縮めるときは 4 点（テクスチャの補間で 4x4 の平均）、戻すときは 9 点のテント形でぼかす。色は線形の値でためる
'use strict';
// photo が true なら（夜景）、写真らしい仕上げも足す: 明るい点から縦横と斜めに伸びる光の筋（スター）、画面の四隅を少し暗くする
// 周辺減光、ごく弱い粒子のノイズ（スマホで撮った夜景に近い見え方に）
function makeBloom(device, format, photo = false) {
  const LEVELS = 6, HDR = 'rgba16float';
  const code = /* wgsl */`
struct P { texel: vec2f, threshold: f32, strength: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var bloom: texture_2d<f32>;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(q.x, 1.0 - q.y);
  return o;
}
fn box4(uv: vec2f) -> vec3f {
  let d = p.texel;
  return (textureSample(src, samp, uv + vec2f(-d.x, -d.y)).rgb + textureSample(src, samp, uv + vec2f(d.x, -d.y)).rgb
        + textureSample(src, samp, uv + vec2f(-d.x, d.y)).rgb + textureSample(src, samp, uv + vec2f(d.x, d.y)).rgb) * 0.25;
}
// 最初の段: 画面（sRGB）を線形に戻し、明るさが threshold を超えた分だけを残す（なめらかに）
@fragment fn fsPre(i: V) -> @location(0) vec4f {
  let c = pow(box4(i.uv), vec3f(2.2));
  let b = max(c.r, max(c.g, c.b));
  let k = clamp(b - p.threshold * 0.5, 0.0, p.threshold);
  let soft = k * k / (2.0 * p.threshold + 1e-4);
  let w = max(soft, b - p.threshold) / max(b, 1e-4);
  return vec4f(c * w, 1.0);
}
@fragment fn fsDown(i: V) -> @location(0) vec4f { return vec4f(box4(i.uv), 1.0); }
// 小さい段を大きい段に足す（足し合わせはブレンドで）
@fragment fn fsUp(i: V) -> @location(0) vec4f {
  let d = p.texel;
  var c = textureSample(src, samp, i.uv).rgb * 4.0;
  c += (textureSample(src, samp, i.uv + vec2f(-d.x, 0.0)).rgb + textureSample(src, samp, i.uv + vec2f(d.x, 0.0)).rgb
      + textureSample(src, samp, i.uv + vec2f(0.0, -d.y)).rgb + textureSample(src, samp, i.uv + vec2f(0.0, d.y)).rgb) * 2.0;
  c += textureSample(src, samp, i.uv + vec2f(-d.x, -d.y)).rgb + textureSample(src, samp, i.uv + vec2f(d.x, -d.y)).rgb
     + textureSample(src, samp, i.uv + vec2f(-d.x, d.y)).rgb + textureSample(src, samp, i.uv + vec2f(d.x, d.y)).rgb;
  return vec4f(c / 16.0, 1.0);
}
// にじみのうち、とても明るい所（光の筋のもと）
fn hot(uv: vec2f) -> vec3f { return max(textureSampleLevel(bloom, samp, uv, 0.0).rgb - vec3f(1.0), vec3f(0.0)); }
// 画面に重ねる: 線形の値で足して sRGB に戻す
@fragment fn fsComp(i: V) -> @location(0) vec4f {
  let c = pow(textureSample(src, samp, i.uv).rgb, vec3f(2.2));
  let b = textureSample(bloom, samp, i.uv).rgb;
  var o = c + b * p.strength;${photo ? `
  // 光の筋: 縦横 4 本と斜め 4 本。3 画素ずつ離れた 8 点を、遠いほど弱く足す
  var star = vec3f(0.0);
  for (var k = 1; k <= 8; k++) {
    let w = exp(-f32(k) * 0.45);
    let dx = vec2f(p.texel.x, 0.0) * f32(k) * 3.0;
    let dy = vec2f(0.0, p.texel.y) * f32(k) * 3.0;
    star += (hot(i.uv + dx) + hot(i.uv - dx) + hot(i.uv + dy) + hot(i.uv - dy)) * w;
    star += (hot(i.uv + (dx + dy) * 0.7) + hot(i.uv - (dx + dy) * 0.7) + hot(i.uv + (dx - dy) * 0.7) + hot(i.uv - (dx - dy) * 0.7)) * w * 0.4;
  }
  o += star * 0.03;
  // 周辺減光（四隅で 3 割ほど暗く）
  let r = length((i.uv - 0.5) * vec2f(1.0, 0.85)) * 1.45;
  o *= 1.0 - 0.3 * pow(clamp(r, 0.0, 1.0), 2.5);
  // 粒子のノイズ（画素ごとに決まった値。暗い所ほど目立たないよう、明るさの平方根に比べる）
  let n = fract(sin(dot(floor(i.pos.xy), vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  o += n * 0.006 * (0.2 + sqrt(dot(o, vec3f(0.299, 0.587, 0.114))));` : ''}
  return vec4f(pow(max(o, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
}`;
  const module = device.createShaderModule({ code });
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} }] });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const pipe = (entry, fmt, blend) => device.createRenderPipeline({ layout: pl, vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: entry, targets: [{ format: fmt, blend }] }, primitive: { topology: 'triangle-list' } });
  const pre = pipe('fsPre', HDR), down = pipe('fsDown', HDR), up = pipe('fsUp', HDR, add), comp = pipe('fsComp', format);
  const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const dummy = device.createTexture({ size: [1, 1], format: HDR, usage: GPUTextureUsage.TEXTURE_BINDING });

  // 大きさごとの段のテクスチャ。止まっているときと動かしている間（縮めて描く）の 2 つの大きさを覚えておく
  const chains = [];
  let chain = null;
  const chainFor = (w, h) => {
    const hit = chains.find(c => c.w === w && c.h === h);
    if (hit) return hit;
    if (chains.length >= 2) chains.shift().destroy();
    const tex = [];
    for (let l = 0, cw = w, ch = h; l < LEVELS; l++) {
      cw = Math.max(1, cw >> 1); ch = Math.max(1, ch >> 1);
      tex.push(device.createTexture({ size: [cw, ch], format: HDR,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
      if (cw === 1 && ch === 1) break;
    }
    // パスごとの値（読む画像の 1 画素の大きさ、しきい値、強さ）。パスの数だけ 256 バイトずつ
    const ubuf = device.createBuffer({ size: 256 * (tex.length * 2 + 1), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    chain = { w, h, tex, ubuf, destroy: () => { tex.forEach(t => t.destroy()); ubuf.destroy(); } };
    chains.push(chain);
    return chain;
  };
  // src（画面の形式、TEXTURE_BINDING 付き）にのせたにじみを dst（画面の形式）に描く。w, h は src の大きさ
  function apply(enc, src, dst, w, h, threshold, strength, own) {
    const c = own || chainFor(w, h), n = c.tex.length;
    let slot = 0;
    const pass = (pipeline, view, from, fw, fh, bloomTex, load) => {
      device.queue.writeBuffer(c.ubuf, slot * 256, new Float32Array([1 / fw, 1 / fh, threshold, strength]));
      const bind = device.createBindGroup({ layout, entries: [
        { binding: 0, resource: from.createView() }, { binding: 1, resource: samp },
        { binding: 2, resource: { buffer: c.ubuf, offset: slot * 256, size: 16 } },
        { binding: 3, resource: (bloomTex || dummy).createView() }] });
      slot++;
      const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(pipeline); p.setBindGroup(0, bind); p.draw(3); p.end();
    };
    pass(pre, c.tex[0].createView(), src, w, h);
    for (let l = 1; l < n; l++) pass(down, c.tex[l].createView(), c.tex[l - 1], c.tex[l - 1].width, c.tex[l - 1].height);
    for (let l = n - 2; l >= 0; l--) pass(up, c.tex[l].createView(), c.tex[l + 1], c.tex[l + 1].width, c.tex[l + 1].height, null, true);
    pass(comp, dst, src, w, h, c.tex[0]);
  }
  // スクリーンショット用: 別の大きさの段を作って使い、使い終えたら捨てる
  function applyOnce(enc, src, dst, w, h, threshold, strength) {
    const c = chainFor(w, h);
    chains.splice(chains.indexOf(c), 1);     // 呼んだ側が使い終えたら捨てる
    apply(enc, src, dst, w, h, threshold, strength, c);
    return c;
  }
  return { apply, applyOnce };
}
