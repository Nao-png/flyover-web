// WebGPU 版のビューア（gpu.html）の季節の色（?season=）で、スプラットに木の葉かどうかの印を付ける作業用のスレッド。
// 印を付ける処理（gpu-season.js の markTreeSplats）は、細かいタイル 1 枚で 75 ms ほどかかり、メインスレッドでは画面が
// 止まったので、ここで同じ処理をする。
// 受け取るもの: { id, buf: glb のバイト列（Uint8Array）, planes: HEVC の面（[{ w, h, y, uv }]）, fine }
// 返すもの: { id, buf, planes }（buf は印を付けたもの。どちらも受け取ったものを送り返す）か、それに error を足したもの
'use strict';
importScripts('gpu-season.js');

const transfers = (buf, planes) => [buf.buffer, ...(planes || []).flatMap(p => p && p.y ? [p.y.buffer, p.uv.buffer] : [])];
onmessage = async ({ data: { id, buf, planes, fine } }) => {
  let error;
  try { await markTreeSplats(buf, planes, fine); } catch (e) { error = String(e && e.stack || e); }
  postMessage({ id, buf, planes, error }, transfers(buf, planes));
};
