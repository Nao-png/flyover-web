// WebGPU 版のビューア（gpu.html）の画面の上の光芒（ゴッドレイ）。Mitchell「Volumetric Light Scattering as a Post-Process」
// （GPU Gems 3、2007）の方法: 空が見えている画素（奥行きが 0。奥行きは逆向きで、空は書かない）だけを、太陽に近いほど重く
// 取り出し（縦横 1/4。空の色ごと取るので、雲の陰と夕焼けの色もそのまま乗る）、太陽の画面の位置へ向かって放射状にぼかし
// （TAPS 点を 3 回入れ子にして、実質 TAPS³ 点）、元の画面に線形の値で足す。建物の隙間から差す光の筋になる。
// 太陽が画面の外へ出るほど弱め、カメラの後ろや地平線の下 3° より低いときは足さない。
// Ray（kuwacom）のシェーダーの調べで知った組み立て（空の画素 x 角度の重みのマスク、3 回の入れ子の放射状のぼかし）を、
// 論文から書いたもの（コードは使っていない）
'use strict';
function makeGodrays(device, format) {
  // 角度の重みの広がり（画面の高さに対する割合）と、取り出す明るさのしきい値（線形の値）
  const TAPS = 8, LOW = 'rgba16float', MASK_WIDTH = 0.15, MASK_LUM = 0.7;
  const code = /* wgsl */`
// sun: 太陽の画面の位置（uv）と、w に全体の強さ（0 なら足さない）。span: このパスでぼかす長さ（太陽までの距離に対する割合）。
// mask: 角度の重みの広がり（画面の高さに対する割合）、画面の縦横比、取り出す明るさのしきい値
struct P { sun: vec4f, span: vec4f, mask: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var rays: texture_2d<f32>;
@group(0) @binding(4) var depth: DEPTH_T;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(q.x, 1.0 - q.y);
  return o;
}
// 1: 空の画素だけを取り出す（4 x 4 画素から 4 点。奥行きは textureLoad で読む）
@fragment fn fsMask(i: V) -> @location(0) vec4f {
  let full = vec2f(textureDimensions(src));
  var c = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    let o = vec2f(f32(k & 1) - 0.5, f32(k >> 1) - 0.5) * 2.0;
    let px = clamp(vec2i(i.uv * full + o), vec2i(0), vec2i(full) - 1);
    let sky = select(0.0, 1.0, DEPTH_LOAD(px) == 0.0);
    c += pow(textureLoad(src, px, 0).rgb, vec3f(2.2)) * sky;
  }
  c *= 0.25;
  // 太陽のまわりの明るい空だけ（明るさが p.mask.z を超えた分）。一様な空まで取ると、筋にならず全体が白くかすんだ
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c *= max(lum - p.mask.z, 0.0) / max(lum, 1e-4);
  let d = (i.uv - p.sun.xy) * vec2f(p.mask.y, 1.0);
  let w = exp(-dot(d, d) / (p.mask.x * p.mask.x));
  return vec4f(c * w, 1.0);
}
// 2: 太陽へ向かう放射状のぼかし（TAPS 点の平均）
@fragment fn fsBlur(i: V) -> @location(0) vec4f {
  let dir = (p.sun.xy - i.uv) * p.span.x;
  var c = vec3f(0.0);
  for (var k = 0; k < ${TAPS}; k++) {
    c += textureSampleLevel(rays, samp, i.uv + dir * (f32(k) / ${TAPS}.0), 0.0).rgb;
  }
  return vec4f(c / ${TAPS}.0, 1.0);
}
// 3: 元の画面に足す
@fragment fn fsComp(i: V) -> @location(0) vec4f {
  let c = pow(textureSample(src, samp, i.uv).rgb, vec3f(2.2));
  let r = textureSample(rays, samp, i.uv).rgb;
  return vec4f(pow(max(c + r * p.sun.w, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
}`;
  const variant = ms => device.createShaderModule({ code: code
    .replace('DEPTH_T', ms ? 'texture_depth_multisampled_2d' : 'texture_depth_2d')
    .replace('DEPTH_LOAD(px)', ms ? 'textureLoad(depth, px, 0)' : 'textureLoad(depth, px, 0)') });
  const layouts = {}, pipes = {};
  const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const forMs = ms => {
    const k = ms ? 'ms' : 'one';
    if (pipes[k]) return pipes[k];
    const module = variant(ms);
    const layout = layouts[k] = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', multisampled: ms } }] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipe = (entry, fmt) => device.createRenderPipeline({ layout: pl, vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: entry, targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } });
    return (pipes[k] = { layout, mask: pipe('fsMask', LOW), blur: pipe('fsBlur', LOW), comp: pipe('fsComp', format) });
  };
  const dummy = device.createTexture({ size: [1, 1], format: LOW, usage: GPUTextureUsage.TEXTURE_BINDING });
  // 大きさごとの低い解像度のテクスチャ 2 枚と、足したあとの画面（にじみを続けて掛けるとき用）
  const chains = [];
  const chainFor = (w, h) => {
    const hit = chains.find(c => c.w === w && c.h === h);
    if (hit) return hit;
    if (chains.length >= 2) chains.shift().destroy();
    const lw = Math.max(1, Math.round(w / 4)), lh = Math.max(1, Math.round(h / 4));
    const mk = (fmt, cw, ch) => device.createTexture({ size: [cw, ch], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const c = { w, h, a: mk(LOW, lw, lh), b: mk(LOW, lw, lh), out: mk(format, w, h),
      ubuf: device.createBuffer({ size: 256 * 5, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) };
    c.destroy = () => { c.a.destroy(); c.b.destroy(); c.out.destroy(); c.ubuf.destroy(); };
    chains.push(c);
    return c;
  };
  // src（画面の形式）と depth（奥行き。ms なら MSAA）から光芒を足した画面を dst に描く（dst を渡さなければ自分のテクスチャに
  // 描いてそれを返す）。sun: [u, v, 強さ]（強さ 0 なら何もしないで false）
  function apply(enc, src, depthTex, ms, w, h, sun, dst, own) {
    if (!sun || !(sun[2] > 0)) return false;
    const P = forMs(ms), c = own || chainFor(w, h);
    const view = dst || c.out.createView();
    const dv = depthTex.createView({ aspect: 'depth-only' });
    let slot = 0;
    const pass = (pipe, target, rays, span) => {
      device.queue.writeBuffer(c.ubuf, slot * 256, new Float32Array([sun[0], sun[1], 0, sun[2], span, 0, 0, 0, MASK_WIDTH, w / h, MASK_LUM, 0]));
      const bind = device.createBindGroup({ layout: P.layout, entries: [
        { binding: 0, resource: src.createView() }, { binding: 1, resource: samp },
        { binding: 2, resource: { buffer: c.ubuf, offset: slot * 256, size: 48 } },
        { binding: 3, resource: (rays || dummy).createView() }, { binding: 4, resource: dv }] });
      slot++;
      const r = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      r.setPipeline(pipe); r.setBindGroup(0, bind); r.draw(3); r.end();
    };
    // 入れ子のぼかし: 1 回目は太陽までの距離の 0.85 / TAPS² の長さ、2 回目は 0.85 / TAPS、3 回目は 0.85
    pass(P.mask, c.a.createView(), null, 0);
    pass(P.blur, c.b.createView(), c.a, 0.85 / (TAPS * TAPS));
    pass(P.blur, c.a.createView(), c.b, 0.85 / TAPS);
    pass(P.blur, c.b.createView(), c.a, 0.85);
    pass(P.comp, view, c.b, 0);
    return dst ? true : c.out;
  }
  // スクリーンショット用: 別の大きさのテクスチャを作って使い、使い終えたら捨てる
  function applyOnce(enc, src, depthTex, ms, w, h, sun, dst) {
    const c = chainFor(w, h);
    chains.splice(chains.indexOf(c), 1);
    const r = apply(enc, src, depthTex, ms, w, h, sun, dst, c);
    return r ? c : null;
  }
  return { apply, applyOnce };
}
