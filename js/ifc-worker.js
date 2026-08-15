// ifc-worker.js — runs the heavy IFC metadata/QTO walk (quantities, storeys,
// elements, groups) off the main thread, so a large model doesn't freeze the UI.
// Geometry streaming stays on the main thread (viewer.js) since it feeds three.js
// buffers directly; this worker only produces the QTO-side JS data + progress ticks.

import * as WebIFC from '../vendor/web-ifc-api.js';

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

function readQuantity(q) {
  const name = String(val(q.Name) || '').toLowerCase();
  if (q.VolumeValue !== undefined) return { bucket: 'volume', v: val(q.VolumeValue) };
  if (q.AreaValue !== undefined) return { bucket: 'area', v: val(q.AreaValue), name };
  if (q.LengthValue !== undefined) return { bucket: 'length', v: val(q.LengthValue), name };
  if (q.WeightValue !== undefined) return { bucket: 'weight', v: val(q.WeightValue) };
  if (q.CountValue !== undefined) return { bucket: 'count', v: val(q.CountValue) };
  return null;
}

let api = null;
async function getApi() {
  if (api) return api;
  const base = new URL('../vendor/', import.meta.url).href;
  const a = new WebIFC.IfcAPI();
  a.SetWasmPath(base, true);
  await a.Init();
  api = a;
  return api;
}

function post(pct, phase) { self.postMessage({ type: 'progress', pct, phase }); }

self.onmessage = async (e) => {
  const { buffer } = e.data;
  let modelID = null;
  try {
    const ifcApi = await getApi();
    post(2, 'open');
    modelID = ifcApi.OpenModel(new Uint8Array(buffer));

    // 1) map expressID -> quantities via IfcRelDefinesByProperties → IfcElementQuantity
    post(5, 'quantities');
    const qtyByElement = new Map();
    const rels = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < rels.size(); i++) {
      let rel;
      try { rel = ifcApi.GetLine(modelID, rels.get(i)); } catch { continue; }
      const defRef = rel.RelatingPropertyDefinition;
      if (!defRef) continue;
      let def;
      try { def = ifcApi.GetLine(modelID, defRef.value, true); } catch { continue; }
      if (!def || !def.Quantities) continue;
      const buckets = {};
      for (const q of def.Quantities) {
        if (!q) continue;
        const r = readQuantity(q);
        if (r && typeof r.v === 'number') buckets[r.bucket] = (buckets[r.bucket] || 0) + r.v;
      }
      for (const ref of rel.RelatedObjects || []) {
        if (!ref) continue;
        const cur = qtyByElement.get(ref.value) || {};
        for (const [k, v] of Object.entries(buckets)) cur[k] = (cur[k] || 0) + v;
        qtyByElement.set(ref.value, cur);
      }
    }

    // 2) map element -> building storey
    post(20, 'storeys');
    const storeyByElement = new Map();
    const storeyInfo = new Map();
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

    // 3) walk element types (the dominant cost on big models — report per-type progress)
    const elements = [];
    for (let ti = 0; ti < ELEMENT_TYPES.length; ti++) {
      const [constName, label] = ELEMENT_TYPES[ti];
      const typeCode = WebIFC[constName];
      if (typeCode !== undefined) {
        let ids;
        try { ids = ifcApi.GetLineIDsWithType(modelID, typeCode); } catch { ids = null; }
        if (ids) {
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
      }
      post(30 + Math.round((ti + 1) / ELEMENT_TYPES.length * 55), 'elements');
    }

    // 4) aggregate into groups (typology = type + name)
    post(90, 'groups');
    const groupMap = new Map();
    const groupStoreys = new Map();
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
      g.globalIds.push(el.globalId || null);
      const sname = storeyInfo.get(el.storeyId)?.name;
      if (sname) groupStoreys.get(key).add(sname);
    }
    for (const [key, set] of groupStoreys) groupMap.get(key).storeys = [...set].sort();
    const groups = [...groupMap.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

    post(99, 'done');
    self.postMessage({ type: 'done', elements, groups, storeys });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  } finally {
    // this worker's own model handle is worker-local — the main thread opens its
    // own instance for geometry streaming, so we always free this one
    if (modelID !== null) { try { api.CloseModel(modelID); } catch { /* already gone */ } }
  }
};
