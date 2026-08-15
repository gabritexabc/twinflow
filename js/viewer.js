// viewer.js — three.js viewer fed by web-ifc geometry streaming

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getApi } from './ifc.js';

let renderer, scene, camera, controls, raycaster, pointer;
let modelGroup = null;
const selectedIds = new Set(); // multi-select: click toggles an element in/out
let onSelectCb = null;

export function initViewer(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10161f);

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  camera.position.set(15, 12, 15);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  // Lighting rig. One key light and a near-black ground term left every surface facing
  // away from it reading as a dark blob — and in a viewer you ORBIT, so half of what you
  // look at was always the far side. The fix is not a brighter key (that blows out the
  // status colours, which carry meaning here) but light arriving from more directions.
  //
  // The ground colour of the hemisphere was 0x223, nearly black, so undersides of slabs
  // and soffits went to almost nothing. Lifting it is what makes a floor plate read as a
  // floor plate from below.
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a4358, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(20, 30, 15);
  scene.add(key);
  // Fill from the opposite side, cool and weak: it recovers shape on the shadow side
  // without competing with the key, so the form still reads as lit from one direction.
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.45);
  fill.position.set(-18, 10, -12);
  scene.add(fill);
  // Up from below, weaker still — soffits and the undersides of beams stop being holes.
  const bounce = new THREE.DirectionalLight(0xffffff, 0.22);
  bounce.position.set(-4, -20, 8);
  scene.add(bounce);
  // A headlight on the camera, so whatever you have turned towards you is always lit.
  // It has to be parented to the camera AND the camera added to the scene, or the light
  // is not part of the graph that gets rendered.
  const headlight = new THREE.DirectionalLight(0xffffff, 0.35);
  headlight.position.set(0, 0, 1);
  camera.add(headlight);
  scene.add(camera);
  const grid = new THREE.GridHelper(60, 60, 0x2a3554, 0x1a2340);
  scene.add(grid);

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  canvas.addEventListener('pointerdown', (e) => {
    canvas._downAt = [e.clientX, e.clientY];
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = canvas._downAt;
    if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return; // it was a drag
    pick(e, canvas);
  });

  const resize = () => {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  renderer.setAnimationLoop(() => {
    if (!viewerActive || document.hidden) return; // skip frames when the 3D view isn't visible
    controls.update();
    renderer.render(scene, camera);
  });
}

let viewerActive = true;
export function setViewerActive(v) { viewerActive = v; }

export function onSelect(cb) { onSelectCb = cb; }

function setHighlight(id, on) {
  if (!modelGroup) return;
  for (const m of modelGroup.children) {
    if (m.userData.expressID === id) m.material.emissive?.setHex(on ? 0x2255ff : 0x000000);
  }
}

function pick(e, canvas) {
  if (!modelGroup) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(modelGroup.children.filter(m => m.visible), false);

  if (hits.length) {
    const id = hits[0].object.userData.expressID;
    if (selectedIds.has(id)) { selectedIds.delete(id); setHighlight(id, false); } // second click deselects
    else { selectedIds.add(id); setHighlight(id, true); }
    onSelectCb?.(id, [...selectedIds]);
  } else {
    onSelectCb?.(null, [...selectedIds]); // empty click keeps the selection (misclicks are common)
  }
}

export function getSelection() { return [...selectedIds]; }

export function clearSelection() {
  for (const id of selectedIds) setHighlight(id, false);
  selectedIds.clear();
  onSelectCb?.(null, []);
}

// includeIds: optional Set of expressIDs — with it, web-ifc only tessellates the
// requested elements (StreamMeshes), which is the big lever for load speed
export async function loadModelGeometry(modelID, includeIds = null) {
  const api = await getApi();
  clearModel();
  modelGroup = new THREE.Group();

  const handleMesh = (mesh) => {
    const placed = mesh.geometries;
    for (let i = 0; i < placed.size(); i++) {
      const pg = placed.get(i);
      let geom;
      try { geom = api.GetGeometry(modelID, pg.geometryExpressID); } catch { continue; }
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      if (!verts.length || !indices.length) continue;

      const bg = new THREE.BufferGeometry();
      const interleaved = new THREE.InterleavedBuffer(new Float32Array(verts), 6);
      bg.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
      bg.setAttribute('normal', new THREE.InterleavedBufferAttribute(interleaved, 3, 3));
      bg.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

      const c = pg.color;
      const material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(c.x, c.y, c.z),
        transparent: c.w < 1,
        opacity: c.w,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(bg, material);
      const mat = new THREE.Matrix4();
      mat.fromArray(pg.flatTransformation);
      m.applyMatrix4(mat);
      m.userData.expressID = mesh.expressID;
      m.userData.origColor = material.color.getHex();
      modelGroup.add(m);
      geom.delete();
    }
  };

  if (includeIds) api.StreamMeshes(modelID, [...includeIds], handleMesh);
  else api.StreamAllMeshes(modelID, handleMesh);

  scene.add(modelGroup);
  fitCameraToModel();
  return modelGroup.children.length;
}

function fitCameraToModel() {
  if (!modelGroup || !modelGroup.children.length) return;
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 10;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(size * 0.9, size * 0.7, size * 0.9));
  camera.near = size / 1000;
  camera.far = size * 20;
  camera.updateProjectionMatrix();
}

export function clearModel() {
  if (modelGroup) {
    modelGroup.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
    });
    scene.remove(modelGroup);
    modelGroup = null;
    selectedIds.clear();
  }
}

// show/hide meshes by predicate over their IFC expressID
export function applyVisibility(predicate) {
  if (!modelGroup) return;
  for (const m of modelGroup.children) {
    m.visible = predicate(m.userData.expressID);
  }
}

// recolor meshes: colorForId(expressID) returns a hex color, or null to restore the original
export function colorByStatus(colorForId) {
  if (!modelGroup) return;
  for (const m of modelGroup.children) {
    const hex = colorForId(m.userData.expressID);
    m.material.color.setHex(hex != null ? hex : m.userData.origColor);
  }
}

export function getColorStats() {
  if (!modelGroup) return {};
  const counts = {};
  for (const m of modelGroup.children) {
    const hex = '#' + m.material.color.getHexString();
    counts[hex] = (counts[hex] || 0) + 1;
  }
  return counts;
}

export function getVisibilityStats() {
  if (!modelGroup) return { total: 0, visible: 0 };
  const total = modelGroup.children.length;
  const visible = modelGroup.children.filter(m => m.visible).length;
  return { total, visible };
}
