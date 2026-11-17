// What Trying Costs: a walk-through museum. This starts everything: it reads the content edited in
// admin mode, builds every room from config.js, then runs the frame loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MUSEUM, ROOMS } from './config.js';
import { renderer, scene, camera, MAX_PIXEL_RATIO, refreshShadows } from './engine.js';
import { prepareRooms, buildInto, roomFrame, roomAt, animators } from './world.js';
import { buildRoom } from './rooms.js';
import { buildRotunda } from './rotunda.js';
import { captureReflectionsWhenLoaded } from './reflections.js';
import { mergeStatic } from './batching.js';
import { placePlayer, teleportTo, updateMovement, blocked, isPlaying } from './player.js';
import { updateUI, onQualityChange, getQuality, setQuality, setLoading, music } from './ui.js';

// Text and photos added in admin mode live in content/exhibits.json, keyed by exhibit id, and are
// laid over what config.js says. It's fetched fresh every time so edits show up right away.
const content = await fetch(`content/exhibits.json?t=${Date.now()}`, { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
prepareRooms(content);

// Build each room in its own placed-and-turned group. The page gets a moment to breathe between
// rooms, so the start screen keeps responding while the museum is put together.
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const built = [];
for (const [i, room] of ROOMS.entries()) {
  setLoading(`Building the rooms (${i + 1} of ${ROOMS.length})…`);
  await pause();
  const group = new THREE.Group();
  group.position.set(room.x, 0, room.z);
  group.rotation.y = room.rot ?? 0;
  scene.add(group);
  buildInto(group, roomFrame(room));
  const local = Object.assign(Object.create(room), { x: 0, z: 0 }); // same room, local coordinates
  if (room.shape === 'octagon') buildRotunda(local, group);
  else buildRoom(local);
  mergeStatic(group);
  built.push({ room, group });
}
buildInto(scene, { x: 0, z: 0, rot: 0 });
scene.add(new THREE.HemisphereLight(0xfff6ea, 0x4a3f35, 0.6));
// Lights live outside the rooms, so hiding a far-away room (below) never changes how many lights
// there are, which would make every material rebuild its shader and stutter.
scene.updateMatrixWorld(true);
for (const { group } of built) {
  const lights = [];
  group.traverse((o) => o.isLight && lights.push(o));
  for (const light of lights) scene.attach(light);
}

// ---------------------------------------------------------------- only draw what can be seen
// A room is drawn only when you are in it or could see into it: the rooms next door, and the rooms
// beyond the passage or the rotunda, which you can see straight across. Everything else stays hidden.
const neighbours = new Map(ROOMS.map((r) => [r, new Set()]));
for (const room of ROOMS) {
  const links = [...Object.values(room.doors).flat(), ...room.openings].map((d) => d.to).filter(Boolean);
  for (const other of links) {
    neighbours.get(room).add(other);
    neighbours.get(other).add(room);
  }
}
const seeThrough = (r) => r.passage || r.shape === 'octagon';
function visibleFrom(room) {
  const seen = new Set([room, ...neighbours.get(room)]);
  for (const next of neighbours.get(room)) if (seeThrough(next) || seeThrough(room)) for (const far of neighbours.get(next)) seen.add(far);
  return seen;
}
let shownFrom = null;
function showNearby() {
  // shadows are drawn only now and then, and must include every room when they are
  if (renderer.shadowMap.needsUpdate) return showAll();
  const room = roomAt(camera.position.x, camera.position.z);
  if (!room || room === shownFrom) return; // standing in a doorway: keep what was shown
  shownFrom = room;
  const seen = visibleFrom(room);
  for (const { room: r, group } of built) group.visible = seen.has(r);
}
function showAll() {
  shownFrom = null;
  for (const { group } of built) group.visible = true;
}

// ---------------------------------------------------------------- getting ready behind the start screen
// Every shader is compiled and every texture sent to the graphics chip before the doors open, so
// nothing has to be prepared (and stutter) the first time a room comes into view. The reflections
// are photographed first, once the pictures and the statue have loaded, as they change the materials.
function uploadTextures() {
  const seen = new Set();
  scene.traverse((o) => {
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const value of Object.values(m)) if (value?.isTexture && !seen.has(value)) seen.add(value);
    }
  });
  for (const t of seen) if (!t.isRenderTargetTexture) renderer.initTexture(t);
}
function prepare() {
  showAll();
  renderer.compile(scene, camera);
  uploadTextures();
  refreshShadows();
}
setLoading('Hanging the pictures…');
await pause();
prepare(); // what's there so far, so the first look around is already smooth
captureReflectionsWhenLoaded(built, () => {
  prepare();
  renderer.render(scene, camera); // draws the shadows once, with every room shown
  setLoading(null);
});

const spawn = MUSEUM.spawn ?? {};
placePlayer(spawn.x ?? ROOMS[0].x, spawn.z ?? ROOMS[0].z, spawn.facing ?? 'north');

// ---------------------------------------------------------------- high graphics: post-processing
// soft contact shadows (GTAO) and a gentle glow around bright lights (bloom)
let composer = null;
function setupComposer() {
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
  // worked out at half resolution (it's a soft effect, so that's invisible) for a quarter of the cost
  const fullSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => fullSize(Math.ceil(w / 2), Math.ceil(h / 2));
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.2, samples: 12 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.18, 0.4, 2.2));
  composer.addPass(new OutputPass());
  sizeComposer();
}
function sizeComposer() {
  composer?.setPixelRatio(renderer.getPixelRatio());
  composer?.setSize(window.innerWidth, window.innerHeight);
}
onQualityChange((q) => {
  if (q === 'high' && !composer) setupComposer();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizeComposer();
});

// ---------------------------------------------------------------- keeping it smooth
// Every two seconds of walking, check the frame rate. Below 50 frames a second, first draw fewer
// pixels (down to one per screen pixel), then switch off the high-graphics effects, then draw fewer
// pixels still. Sharpness comes back only after a run of smooth checks, and never to a level that
// already proved too slow, so it settles instead of bouncing up and down.
const MIN_PIXEL_RATIO = 0.7;
let sampleStart = performance.now();
let sampleFrames = 0;
let smoothRuns = 0;
let ceiling = MAX_PIXEL_RATIO;
function keepSmooth(now) {
  sampleFrames++;
  const elapsed = now - sampleStart;
  if (elapsed < 2000) return;
  const fps = (sampleFrames * 1000) / elapsed;
  sampleFrames = 0;
  sampleStart = now;
  if (!isPlaying() || document.hidden) return; // menus and paused tabs don't count
  const current = renderer.getPixelRatio();
  let next = current;
  if (fps < 50) {
    smoothRuns = 0;
    if (current > 1) next = Math.max(1, current - 0.25);
    else if (getQuality() === 'high') setQuality('standard', { auto: true });
    else next = Math.max(MIN_PIXEL_RATIO, current - 0.1);
    if (next < current) ceiling = Math.min(ceiling, current - 0.05);
  } else if (fps > 58 && ++smoothRuns >= 3 && current + 0.1 <= ceiling) {
    smoothRuns = 0;
    next = current + 0.1;
  }
  if (next !== current) {
    renderer.setPixelRatio(next);
    renderer.setSize(window.innerWidth, window.innerHeight);
    sizeComposer();
  }
}

// ---------------------------------------------------------------- frame loop
const clock = new THREE.Clock();
renderer.setAnimationLoop((now) => {
  keepSmooth(now);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateMovement(dt);
  for (const animate of animators) animate(clock.elapsedTime);
  updateUI();
  showNearby();
  if (getQuality() === 'high' && composer) composer.render(dt);
  else renderer.render(scene, camera);
});

// handy for debugging in the browser console: museum.teleport('rotunda')
window.museum = {
  renderer,
  scene,
  camera,
  music,
  blocked, // blocked(x, z): would a visitor standing here hit something?
  rooms: ROOMS,
  teleport: (id) => teleportTo(ROOMS.find((r) => r.id === id) ?? ROOMS[0]),
};
