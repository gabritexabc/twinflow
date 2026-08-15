// ifc.js — IFC parsing and quantity takeoff using web-ifc (WASM)

import * as WebIFC from 'web-ifc';

let api = null;

const WEB_IFC_CDN = 'https://cdn.jsdelivr.net/npm/web-ifc@0.0.57/';

// Prefer the vendored wasm (resolved relative to the page, so sub-path hosting works);
// fall back to the CDN when the local copy is unreachable.
async function resolveWasmBase() {
  const local = new URL('vendor/', document.baseURI).href;
  try {
    const r = await fetch(local + 'web-ifc.wasm', { method: 'HEAD' });
    if (r.ok) return local;
  } catch { /* offline from local server? try CDN */ }
  console.warn('[ifc] local web-ifc.wasm not reachable — falling back to CDN');
  return WEB_IFC_CDN;
}

export async function getApi() {
  if (api) return api;
  const init = async (base) => {
    const a = new WebIFC.IfcAPI();
    a.SetWasmPath(base, true);
    await a.Init();
    return a;
  };
  const base = await resolveWasmBase();
  try {
    api = await init(base);
  } catch (e) {
    if (base !== WEB_IFC_CDN) {
      console.warn('[ifc] wasm init failed locally, retrying via CDN:', e.message);
      api = await init(WEB_IFC_CDN);
    } else {
      throw e;
    }
  }
  return api;
}

// Building element types we take off. Each entry: [web-ifc constant name, friendly label]
const ELEMENT_TYPES = [
  ['IFCWALL', 'Wall'],
  ['IFCWALLSTANDARDCASE', 'Wall'],
  ['IFCSLAB', 'Slab'],
  ['IFCBEAM', 'Beam'],
  ['IFCCOLUMN', 'Column'],
  ['IFCDOOR', 'Door'],
  ['IFCWINDOW', 'Window'],
  ['IFCSTAIR', 'Stair'],
  ['IFCSTAIRFLIGHT', 'Stair Flight'],
  ['IFCROOF', 'Roof'],
  ['IFCFOOTING', 'Footing'],
  ['IFCPILE', 'Pile'],
  ['IFCPLATE', 'Plate'],
  ['IFCMEMBER', 'Member'],
  ['IFCCOVERING', 'Covering'],
  ['IFCRAILING', 'Railing'],
  ['IFCCURTAINWALL', 'Curtain Wall'],
  ['IFCRAMP', 'Ramp'],
  ['IFCBUILDINGELEMENTPROXY', 'Element (proxy)'],
];

const val = (x) => (x && x.value !== undefined ? x.value : x ?? null);

// Map an IfcPhysicalQuantity line to a canonical bucket
function readQuantity(q) {
  const name = String(val(q.Name) || '').toLowerCase();
  if (q.VolumeValue !== undefined) return { bucket: 'volume', v: val(q.VolumeValue) };
  if (q.AreaValue !== undefined) {
    // prefer side/gross area but accept any area
    return { bucket: 'area', v: val(q.AreaValue), name };
  }
  if (q.LengthValue !== undefined) return { bucket: 'length', v: val(q.LengthValue), name };
  if (q.WeightValue !== undefined) return { bucket: 'weight', v: val(q.WeightValue) };
  if (q.CountValue !== undefined) return { bucket: 'count', v: val(q.CountValue) };
  return null;
}

/**
 * Parse an IFC buffer and return:
 * { modelID, elements: [{id, globalId, type, name, tag, volume, area, length, weight}],
 *   groups: [{key, type, name, count, volume, area, length, weight, elementIds}] }
 */
export async function parseIfc(buffer) {
  const ifcApi = await getApi();
  const modelID = ifcApi.OpenModel(new Uint8Array(buffer));

  // 1) map expressID -> quantities via IfcRelDefinesByProperties → IfcElementQuantity
  const qtyByElement = new Map();
  const rels = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < rels.size(); i++) {
    let rel;
    try { rel = ifcApi.GetLine(modelID, rels.get(i)); } catch { continue; }
    const defRef = rel.RelatingPropertyDefinition;
    if (!defRef) continue;
    let def;
    try { def = ifcApi.GetLine(modelID, defRef.value, true); } catch { continue; }
    if (!def || !def.Quantities) continue; // not an IfcElementQuantity
    const buckets = {};
    for (const q of def.Quantities) {
      if (!q) continue;
      const r = readQuantity(q);
      if (r && typeof r.v === 'number') {
        buckets[r.bucket] = (buckets[r.bucket] || 0) + r.v;
      }
    }
    for (const ref of rel.RelatedObjects || []) {
      if (!ref) continue;
      const cur = qtyByElement.get(ref.value) || {};
      for (const [k, v] of Object.entries(buckets)) cur[k] = (cur[k] || 0) + v;
      qtyByElement.set(ref.value, cur);
    }
  }

  // 2) map element -> building storey (for level filtering in the viewer)
  const storeyByElement = new Map();
  const storeyInfo = new Map(); // storey expressID -> { id, name, elevation }
  const crels = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < crels.size(); i++) {
    let rel;
    try { rel = ifcApi.GetLine(modelID, crels.get(i)); } catch { continue; }
    const structRef = rel.RelatingStructure;
    if (!structRef) continue;
    let stype;
    try { stype = ifcApi.GetLineType(modelID, structRef.value); } catch { continue; }
    if (stype !== WebIFC.IFCBUILDINGSTOREY) continue;
    if (!storeyInfo.has(structRef.value)) {
      try {
        const st = ifcApi.GetLine(modelID, structRef.value);
        storeyInfo.set(structRef.value, {
          id: structRef.value,
          name: val(st.Name) || 'Level ' + structRef.value,
          elevation: val(st.Elevation) ?? 0,
        });
      } catch { continue; }
    }
    for (const ref of rel.RelatedElements || []) {
      if (ref) storeyByElement.set(ref.value, structRef.value);
    }
  }
  const storeys = [...storeyInfo.values()].sort((a, b) => a.elevation - b.elevation);

  // 3) walk element types
  const elements = [];
  for (const [constName, label] of ELEMENT_TYPES) {
    const typeCode = WebIFC[constName];
    if (typeCode === undefined) continue;
    let ids;
    try { ids = ifcApi.GetLineIDsWithType(modelID, typeCode); } catch { continue; }
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      let line;
      try { line = ifcApi.GetLine(modelID, id); } catch { continue; }
      const q = qtyByElement.get(id) || {};
      elements.push({
        id,
        globalId: val(line.GlobalId),
        type: label,
        ifcClass: constName,
        name: val(line.Name) || val(line.ObjectType) || label,
        tag: val(line.Tag),
        storeyId: storeyByElement.get(id) ?? null,
        volume: q.volume ?? null,
        area: q.area ?? null,
        length: q.length ?? null,
        weight: q.weight ?? null,
      });
    }
  }

  // 4) aggregate into groups (typology = type + name)
  const groupMap = new Map();
  const groupStoreys = new Map(); // key -> Set of storey names (for QTO storey filtering)
  for (const el of elements) {
    const key = el.type + '|' + el.name;
    let g = groupMap.get(key);
    if (!g) {
      g = { key, type: el.type, name: el.name, count: 0, volume: 0, area: 0, length: 0, weight: 0, elementIds: [], globalIds: [], storeys: [] };
      groupMap.set(key, g);
      groupStoreys.set(key, new Set());
    }
    g.count += 1;
    g.volume += el.volume || 0;
    g.area += el.area || 0;
    g.length += el.length || 0;
    g.weight += el.weight || 0;
    g.elementIds.push(el.id);
    g.globalIds.push(el.globalId || null); // physical↔digital link for QR labels
    const sname = storeyInfo.get(el.storeyId)?.name;
    if (sname) groupStoreys.get(key).add(sname);
  }
  for (const [key, set] of groupStoreys) groupMap.get(key).storeys = [...set].sort();
  const groups = [...groupMap.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  return { modelID, elements, groups, storeys };
}

export function getElementInfo(modelID, expressID) {
  if (!api) return null;
  try {
    const line = api.GetLine(modelID, expressID);
    return {
      expressID,
      globalId: val(line.GlobalId),
      name: val(line.Name),
      objectType: val(line.ObjectType),
      tag: val(line.Tag),
      class: line.constructor ? line.constructor.name : '',
    };
  } catch {
    return null;
  }
}

export function closeModel(modelID) {
  if (api && modelID !== null && modelID !== undefined) {
    try { api.CloseModel(modelID); } catch { /* already closed */ }
  }
}

let metadataWorker = null;

/**
 * Runs the same walk as parseIfc (quantities, storeys, elements, groups) inside
 * a Web Worker, so a large model doesn't freeze the UI thread. Reports progress
 * via onProgress(pct 0-100). Resolves to { elements, groups, storeys } — no
 * modelID, since the worker's web-ifc instance is separate from the main
 * thread's; open the buffer again with getApi() when geometry is needed.
 */
export function parseIfcMetadata(buffer, onProgress) {
  return new Promise((resolve, reject) => {
    if (!metadataWorker) {
      metadataWorker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
    }
    const worker = metadataWorker;
    const onMessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress?.(msg.pct, msg.phase);
      else if (msg.type === 'done') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        resolve({ elements: msg.elements, groups: msg.groups, storeys: msg.storeys });
      } else if (msg.type === 'error') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        reject(new Error(msg.message));
      }
    };
    const onError = (err) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(err.error || new Error(err.message || 'IFC worker failed'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    // NOT transferred: the caller still needs this same buffer afterwards (main-thread
    // geometry open, upload, local cache) — structured clone copies it to the worker instead
    worker.postMessage({ buffer });
  });
}
