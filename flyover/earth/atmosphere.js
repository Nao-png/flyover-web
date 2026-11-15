// Copyright (c) 2017 Eric Bruneton. All rights reserved.
// このファイルは Bruneton の precomputed_atmospheric_scattering を元にしているので、そのライセンス
// （BSD 3-Clause。全文は atmosphere/LICENSE）に従う。
//
// 大気のテクスチャを前もって計算するワーカー。Eric Bruneton の Precomputed Atmospheric Scattering
// （https://github.com/ebruneton/precomputed_atmospheric_scattering 、BSD ライセンス。atmosphere/LICENSE）の
// atmosphere/model.cc の Precompute を WebGL2 に移したもの。計算の中身（atmosphere/functions.glsl）と大気の値
// （atmosphere/demo/demo.cc の InitModel）は元のまま。
//
// 元との違い（WebGL2 にない機能の代わり）:
// - ジオメトリシェーダーがないので、3D テクスチャは層ごとに framebufferTextureLayer でつないで描く
// - 出力ごとに足し合わせ（ブレンド）を切り替えられないので、上書きする出力と足し合わせる出力は別々に描く
// - 3 波長（680・550・440 nm）で計算し、散乱のテクスチャはミー散乱を 1 つにまとめた形（COMBINED_SCATTERING_TEXTURES）。
//   元のデモの既定（輝度の変換なし・半精度）と同じ
//
// 画面の Cesium とは別の WebGL の中で計算して、結果を Float32Array で返す（Cesium が覚えている GL の状態を
// 乱さないため）。受け取り: { haze（ちりの量の倍率）}。返す: { ok, transmittance, scattering, irradiance, glsl（大気の値と関数。画面の
// シェーダーの前に付ける）, ms } か { ok: false, error }

const TRANSMITTANCE_W = 256, TRANSMITTANCE_H = 64;
const R_SIZE = 32, MU_SIZE = 128, MU_S_SIZE = 32, NU_SIZE = 8;
const SCATTERING_W = NU_SIZE * MU_S_SIZE, SCATTERING_H = MU_SIZE, SCATTERING_D = R_SIZE;
const IRRADIANCE_W = 64, IRRADIANCE_H = 16;
const SCATTERING_ORDERS = 4;

// 大気の値（demo.cc の InitModel。長さの単位は km）。3 つの波長 680・550・440 nm での値
const LAMBDAS = [680, 550, 440];
const SOLAR_IRRADIANCE = [1.474, 1.8504, 1.91198];           // kSolarIrradiance の 680・550・440 nm
const OZONE_CROSS_SECTION = [1.209e-25, 3.5e-25, 1.582e-26];  // kOzoneCrossSection の同じ波長 [m²]
const SUN_ANGULAR_RADIUS = 0.00935 / 2;
const BOTTOM_RADIUS = 6360, TOP_RADIUS = 6420;               // km

// haze: 空気中のちり（ミー散乱）の量の倍率。1 で元のデモの値
function header(haze = 1) {
  const f = x => {
    const s = Number(x).toPrecision(9);
    return /[.e]/.test(s) ? s : s + '.0';
  };
  const v3 = a => `vec3(${a.map(f).join(',')})`;
  const um = LAMBDAS.map(l => l * 1e-3);                     // マイクロメートル
  const rayleigh = um.map(l => 1.24062e-6 * Math.pow(l, -4) * 1000);
  const mie = um.map(() => 5.328e-3 / 1200 * 1000 * haze);   // kMieAngstromAlpha = 0 なので波長によらない
  const maxOzone = 300 * 2.687e20 / 15000;                    // 1 m³ あたりの数
  const ozone = OZONE_CROSS_SECTION.map(c => maxOzone * c * 1000);
  const layer = (w, e, es, lt, c) => `DensityProfileLayer(${[w, e, es, lt, c].map(f).join(',')})`;
  const empty = layer(0, 0, 0, 0, 0);
  const profile = (a, b) => `DensityProfile(DensityProfileLayer[2](${a},${b}))`;
  return `
#define IN(x) const in x
#define OUT(x) out x
#define TEMPLATE(x)
#define TEMPLATE_ARGUMENT(x)
#define assert(x)
const int TRANSMITTANCE_TEXTURE_WIDTH = ${TRANSMITTANCE_W};
const int TRANSMITTANCE_TEXTURE_HEIGHT = ${TRANSMITTANCE_H};
const int SCATTERING_TEXTURE_R_SIZE = ${R_SIZE};
const int SCATTERING_TEXTURE_MU_SIZE = ${MU_SIZE};
const int SCATTERING_TEXTURE_MU_S_SIZE = ${MU_S_SIZE};
const int SCATTERING_TEXTURE_NU_SIZE = ${NU_SIZE};
const int IRRADIANCE_TEXTURE_WIDTH = ${IRRADIANCE_W};
const int IRRADIANCE_TEXTURE_HEIGHT = ${IRRADIANCE_H};
#define COMBINED_SCATTERING_TEXTURES
@DEFINITIONS@
const AtmosphereParameters ATMOSPHERE = AtmosphereParameters(
  ${v3(SOLAR_IRRADIANCE)},
  ${f(SUN_ANGULAR_RADIUS)},
  ${f(BOTTOM_RADIUS)},
  ${f(TOP_RADIUS)},
  ${profile(empty, layer(0, 1, -1 / 8, 0, 0))},
  ${v3(rayleigh)},
  ${profile(empty, layer(0, 1, -1 / 1.2, 0, 0))},
  ${v3(mie.map(x => x * 0.9))},
  ${v3(mie)},
  ${f(0.8)},
  ${profile(layer(25, 0, 0, 1 / 15, -2 / 3), layer(0, 0, 0, -1 / 15, 8 / 3))},
  ${v3(ozone)},
  ${v3([0.1, 0.1, 0.1])},
  ${f(Math.cos(102 / 180 * Math.PI))});
@FUNCTIONS@
`;
}

const VS = `#version 300 es
layout(location = 0) in vec2 vertex;
void main() { gl_Position = vec4(vertex, 0.0, 1.0); }`;

// model.cc の各段のシェーダー（出力は RGBA にそろえる）
const FS = {
  transmittance: `
layout(location = 0) out vec4 transmittance;
void main() {
  transmittance = vec4(ComputeTransmittanceToTopAtmosphereBoundaryTexture(ATMOSPHERE, gl_FragCoord.xy), 1.0);
}`,
  directIrradiance: `
layout(location = 0) out vec4 delta_irradiance;
layout(location = 1) out vec4 irradiance;
uniform sampler2D transmittance_texture;
void main() {
  delta_irradiance = vec4(ComputeDirectIrradianceTexture(ATMOSPHERE, transmittance_texture, gl_FragCoord.xy), 1.0);
  irradiance = vec4(0.0);
}`,
  singleScattering: `
layout(location = 0) out vec4 delta_rayleigh;
layout(location = 1) out vec4 delta_mie;
layout(location = 2) out vec4 scattering;
uniform sampler2D transmittance_texture;
uniform int layer;
void main() {
  vec3 rayleigh, mie;
  ComputeSingleScatteringTexture(ATMOSPHERE, transmittance_texture,
      vec3(gl_FragCoord.xy, float(layer) + 0.5), rayleigh, mie);
  delta_rayleigh = vec4(rayleigh, 1.0);
  delta_mie = vec4(mie, 1.0);
  scattering = vec4(rayleigh, mie.r);
}`,
  scatteringDensity: `
layout(location = 0) out vec4 scattering_density;
uniform sampler2D transmittance_texture;
uniform sampler3D single_rayleigh_scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D multiple_scattering_texture;
uniform sampler2D irradiance_texture;
uniform int scattering_order;
uniform int layer;
void main() {
  scattering_density = vec4(ComputeScatteringDensityTexture(ATMOSPHERE, transmittance_texture,
      single_rayleigh_scattering_texture, single_mie_scattering_texture, multiple_scattering_texture,
      irradiance_texture, vec3(gl_FragCoord.xy, float(layer) + 0.5), scattering_order), 1.0);
}`,
  // 元は delta_irradiance（上書き）と irradiance（足し合わせ）を同時に出す。ここでは 1 つを出して 2 回描く
  indirectIrradiance: `
layout(location = 0) out vec4 irradiance;
uniform sampler3D single_rayleigh_scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D multiple_scattering_texture;
uniform int scattering_order;
void main() {
  irradiance = vec4(ComputeIndirectIrradianceTexture(ATMOSPHERE, single_rayleigh_scattering_texture,
      single_mie_scattering_texture, multiple_scattering_texture, gl_FragCoord.xy, scattering_order), 1.0);
}`,
  multipleScattering: `
layout(location = 0) out vec4 delta_multiple_scattering;
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_density_texture;
uniform int layer;
void main() {
  float nu;
  delta_multiple_scattering = vec4(ComputeMultipleScatteringTexture(ATMOSPHERE, transmittance_texture,
      scattering_density_texture, vec3(gl_FragCoord.xy, float(layer) + 0.5), nu), 1.0);
}`,
  // 元は上と同時に scattering へ delta / RayleighPhaseFunction(nu) を足す。ここでは描いた delta を読んで足す
  addMultipleScattering: `
layout(location = 0) out vec4 scattering;
uniform sampler3D delta_multiple_scattering_texture;
uniform int layer;
void main() {
  float r, mu, mu_s, nu;
  bool ray_r_mu_intersects_ground;
  GetRMuMuSNuFromScatteringTextureFragCoord(ATMOSPHERE, vec3(gl_FragCoord.xy, float(layer) + 0.5),
      r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  vec3 delta = texelFetch(delta_multiple_scattering_texture, ivec3(gl_FragCoord.xy, layer), 0).rgb;
  scattering = vec4(delta / RayleighPhaseFunction(nu), 0.0);
}`,
};

function precompute(definitions, functions, haze) {
  const t0 = performance.now();
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error('WebGL2 が使えない');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('浮動小数のテクスチャに描けない（EXT_color_buffer_float がない）');
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const head = header(haze).replace('@DEFINITIONS@', definitions).replace('@FUNCTIONS@', functions);

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('シェーダーを作れない: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const programs = {};
  for (const [name, body] of Object.entries(FS)) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER,
      '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\nprecision highp sampler3D;\n' + head + body));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('シェーダーをつなげない: ' + gl.getProgramInfoLog(p));
    programs[name] = p;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const params = target => {
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  };
  // 足し合わせるテクスチャは 16 ビット（32 ビットの浮動小数の足し合わせは使えない環境がある）
  const tex2d = (w, h, internal) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    params(gl.TEXTURE_2D);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    return t;
  };
  const tex3d = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    params(gl.TEXTURE_3D);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, SCATTERING_W, SCATTERING_H, SCATTERING_D);
    return t;
  };
  const transmittance = tex2d(TRANSMITTANCE_W, TRANSMITTANCE_H, floatLinear ? gl.RGBA32F : gl.RGBA16F);
  const irradiance = tex2d(IRRADIANCE_W, IRRADIANCE_H, gl.RGBA16F);
  const deltaIrradiance = tex2d(IRRADIANCE_W, IRRADIANCE_H, gl.RGBA16F);
  const scattering = tex3d();
  const deltaRayleigh = tex3d(), deltaMie = tex3d(), deltaDensity = tex3d();
  const deltaMultiple = deltaRayleigh;   // 元と同じく 2 次以降は単散乱のレイリーの場所を使い回す

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE);
  const MAX_ATTACH = 3;
  // targets: [テクスチャ, 3D なら層] の並び。samplers: { 名前: [target, texture] }
  const draw = (name, targets, { samplers = {}, ints = {}, blend = false, w, h }) => {
    for (let i = 0; i < MAX_ATTACH; i++) {
      const t = targets[i];
      if (!t) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
      else if (t[1] === undefined) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t[0], 0);
      else gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, t[0], 0, t[1]);
    }
    gl.drawBuffers(targets.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const p = programs[name];
    gl.useProgram(p);
    // 描き込む先をサンプラーに残さない（同じテクスチャを読み書きするとエラーになる）
    for (let u = 0; u < 6; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_3D, null);
    }
    let unit = 0;
    for (const [s, [target, t]] of Object.entries(samplers)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, t);
      gl.uniform1i(gl.getUniformLocation(p, s), unit++);
    }
    for (const [k, v] of Object.entries(ints)) gl.uniform1i(gl.getUniformLocation(p, k), v);
    gl.viewport(0, 0, w, h);
    if (blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const T2 = t => [gl.TEXTURE_2D, t], T3 = t => [gl.TEXTURE_3D, t];
  const layers = (name, targets, opts) => {
    for (let layer = 0; layer < SCATTERING_D; layer++)
      draw(name, targets.map(t => [t, layer]), { ...opts, ints: { ...opts.ints, layer }, w: SCATTERING_W, h: SCATTERING_H });
  };
  const S = { w: SCATTERING_W, h: SCATTERING_H }, I = { w: IRRADIANCE_W, h: IRRADIANCE_H };

  draw('transmittance', [[transmittance]], { w: TRANSMITTANCE_W, h: TRANSMITTANCE_H });
  draw('directIrradiance', [[deltaIrradiance], [irradiance]], { ...I, samplers: { transmittance_texture: T2(transmittance) } });
  layers('singleScattering', [deltaRayleigh, deltaMie, scattering], { samplers: { transmittance_texture: T2(transmittance) } });
  for (let order = 2; order <= SCATTERING_ORDERS; order++) {
    layers('scatteringDensity', [deltaDensity], {
      samplers: {
        transmittance_texture: T2(transmittance), single_rayleigh_scattering_texture: T3(deltaRayleigh),
        single_mie_scattering_texture: T3(deltaMie), multiple_scattering_texture: T3(deltaMultiple),
        irradiance_texture: T2(deltaIrradiance),
      },
      ints: { scattering_order: order },
    });
    const indirect = {
      ...I,
      samplers: {
        single_rayleigh_scattering_texture: T3(deltaRayleigh), single_mie_scattering_texture: T3(deltaMie),
        multiple_scattering_texture: T3(deltaMultiple),
      },
      ints: { scattering_order: order - 1 },
    };
    draw('indirectIrradiance', [[deltaIrradiance]], indirect);
    draw('indirectIrradiance', [[irradiance]], { ...indirect, blend: true });
    layers('multipleScattering', [deltaMultiple], {
      samplers: { transmittance_texture: T2(transmittance), scattering_density_texture: T3(deltaDensity) },
    });
    layers('addMultipleScattering', [scattering], {
      samplers: { delta_multiple_scattering_texture: T3(deltaMultiple) }, blend: true,
    });
  }
  gl.disable(gl.BLEND);

  // 読み戻す
  const read2d = (t, w, h) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const a = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, a);
    return a;
  };
  for (let i = 1; i < MAX_ATTACH; i++)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  const out = {
    transmittance: read2d(transmittance, TRANSMITTANCE_W, TRANSMITTANCE_H),
    irradiance: read2d(irradiance, IRRADIANCE_W, IRRADIANCE_H),
    scattering: new Float32Array(SCATTERING_W * SCATTERING_H * SCATTERING_D * 4),
  };
  const slice = SCATTERING_W * SCATTERING_H * 4;
  for (let layer = 0; layer < SCATTERING_D; layer++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, scattering, 0, layer);
    gl.readPixels(0, 0, SCATTERING_W, SCATTERING_H, gl.RGBA, gl.FLOAT, out.scattering.subarray(layer * slice, (layer + 1) * slice));
  }
  const err = gl.getError();
  if (err) throw new Error('WebGL のエラー ' + err);
  // 計算に使った GPU のメモリをすぐ返す（この PC はメモリが少ない）
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();
  return { ...out, glsl: head, ms: Math.round(performance.now() - t0) };
}

onmessage = async e => {
  try {
    const haze = e.data && e.data.haze || 1;
    const [definitions, functions] = await Promise.all(
      ['atmosphere/definitions.glsl', 'atmosphere/functions.glsl'].map(u => fetch(u).then(r => r.text())));
    const r = precompute(definitions, functions, haze);
    postMessage({ ok: true, ...r }, [r.transmittance.buffer, r.irradiance.buffer, r.scattering.buffer]);
  } catch (e) {
    postMessage({ ok: false, error: String(e && e.message || e) });
  }
};
