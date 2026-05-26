const loadedSections = new Set();

function sectionPath(sectionName) {
  return `/static/views/${sectionName}.html`;
}

export async function loadSectionTemplate(sectionName) {
  if (!sectionName) return;
  if (loadedSections.has(sectionName)) return;

  const viewId = `view-${sectionName}`;
  const viewEl = document.getElementById(viewId);
  if (!viewEl) return;

  // Backward-compatible default: if static markup already exists, keep it.
  if (viewEl.children.length > 0 || String(viewEl.innerHTML || '').trim()) {
    loadedSections.add(sectionName);
    return;
  }

  const res = await fetch(sectionPath(sectionName), { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`Failed to load ${sectionName} template (${res.status})`);
  }
  viewEl.innerHTML = await res.text();
  loadedSections.add(sectionName);
}

