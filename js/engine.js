// The renderer, scene and camera everything else draws into.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const SMALL_SCREEN = window.matchMedia('(pointer: coarse)').matches; // phones and tablets
export const EYE_HEIGHT = 1.7;

// Laptops with built-in (integrated) graphics, phones and tablets get the lighter settings. Asked
// of a throwaway canvas, because it decides how the real renderer is made.
export const BUILT_IN_GRAPHICS = (() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /Intel|Iris|UHD|HD Graphics|Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Microsoft Basic/i.test(name);
  } catch {
    return false;
  }
})();
// Smoothed edges (multisampling) cost built-in graphics a lot of memory traffic on every frame.
export const renderer = new THREE.WebGLRenderer({ antialias: !BUILT_IN_GRAPHICS, powerPreference: 'high-performance' });
// At most 1.5 pixels per screen pixel (sharper costs a lot and looks the same), and one pixel per
// screen pixel on built-in graphics. app.js lowers it further on computers that can't keep up.
export const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio, BUILT_IN_GRAPHICS ? 1 : 1.5);
renderer.setPixelRatio(MAX_PIXEL_RATIO);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // the soft kind samples far more for little visible gain
// Nothing that casts a shadow ever moves, so shadows are drawn once (and again when something
// loads) instead of on every frame.
renderer.shadowMap.autoUpdate = false;
export function refreshShadows() {
  renderer.shadowMap.needsUpdate = true;
}
document.getElementById('app').appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0e12);
// a neutral studio light for reflections until each room has captured its own (see reflections.js)
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

// near/far kept tight so phones can tell apart surfaces that sit close together (art, mat, wall)
export const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.12, 120);
camera.rotation.order = 'YXZ';
camera.position.y = EYE_HEIGHT;

export const MAX_ANISOTROPY = renderer.capabilities.getMaxAnisotropy();
