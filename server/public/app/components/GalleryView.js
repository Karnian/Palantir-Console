// GalleryView — Skill Pack Gallery (browse, search, install from registry)

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useMemo, useRef, useCallback } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { PackPreviewModal } from './PackPreviewModal.js';

export function GalleryView() {
  const [registry, setRegistry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [previewPack, setPreviewPack] = useState(null);
  const [installing, setInstalling] = useState(null); // registry_id being installed
  const debounceRef = useRef(null);

  const loadRegistry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch('/api/skill-packs/registry');
      setRegistry(data);
    } catch (err) {
      setError(err.message || 'Failed to load registry');
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadRegistry(); }, [loadRegistry]);

  // 200ms debounce for search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const filteredPacks = useMemo(() => {
    if (!registry) return [];
    let packs = registry.packs || [];
    if (selectedCategory !== 'all') {
      packs = packs.filter(p => p.category === selectedCategory);
    }
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase();
      packs = packs.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    }
    return packs;
  }, [registry, selectedCategory, debouncedSearch]);

  const allInstalled = useMemo(() => {
    if (!registry || !registry.packs || registry.packs.length === 0) return false;
    return registry.packs.every(p => p.installed);
  }, [registry]);

  const handleInstall = async (pack) => {
    setInstalling(pack.registry_id);
    try {
      await apiFetchWithToast('/api/skill-packs/registry/install', {
        method: 'POST',
        body: JSON.stringify({
          registry_id: pack.registry_id,
          confirmed_preview: pack._source === 'remote' ? true : undefined,
        }),
      });
      addToast(`Installed "${pack.name}"`, 'success');
      setPreviewPack(null);
      await loadRegistry();
    } catch (err) {
      if (err.status === 409) {
        addToast(err.message || 'Already installed or name conflict', 'error');
      }
      // other errors shown by apiFetchWithToast
    }
    setInstalling(null);
  };

  const handleUpdate = async (pack) => {
    setInstalling(pack.registry_id);
    try {
      await apiFetchWithToast('/api/skill-packs/registry/update', {
        method: 'POST',
        body: JSON.stringify({ registry_id: pack.registry_id }),
      });
      addToast(`Updated "${pack.name}"`, 'success');
      setPreviewPack(null);
      await loadRegistry();
    } catch { /* toast shown */ }
    setInstalling(null);
  };

  // Loading state
  if (loading) {
    return html`<div class="gallery-loading"><div class="loading">Loading registry...</div></div>`;
  }

  // Error state
  if (error) {
    return html`
      <div class="gallery-error">
        <div class="gallery-error-icon">!</div>
        <div class="gallery-error-text">Failed to load registry</div>
        <div class="gallery-error-detail">${error}</div>
        <button class="primary small" onClick=${loadRegistry}>Retry</button>
      </div>
    `;
  }

  const categories = registry?.categories || [];

  return html`
    <div class="gallery-view">
      <div class="gallery-toolbar">
        <div class="gallery-search-wrap">
          <input
            type="text"
            class="form-input gallery-search"
            placeholder="Search packs..."
            value=${search}
            onInput=${e => setSearch(e.target.value)}
          />
        </div>
        <div class="gallery-filters">
          <button
            class="gallery-filter-btn ${selectedCategory === 'all' ? 'active' : ''}"
            onClick=${() => setSelectedCategory('all')}
          >All</button>
          ${categories.map(cat => html`
            <button
              key=${cat.id}
              class="gallery-filter-btn ${selectedCategory === cat.id ? 'active' : ''}"
              onClick=${() => setSelectedCategory(cat.id)}
              title=${cat.name}
            ><span class="gallery-filter-icon">${cat.icon}</span> ${cat.name}</button>
          `)}
        </div>
      </div>

      ${allInstalled && filteredPacks.length > 0 && html`
        <div class="gallery-all-installed">All packs installed</div>
      `}

      ${filteredPacks.length === 0 && html`
        <div class="gallery-empty">
          <div class="gallery-empty-icon">◇</div>
          <div class="gallery-empty-text">No packs found</div>
        </div>
      `}

      <div class="gallery-grid">
        ${filteredPacks.map(pack => {
          const isInstalling = installing === pack.registry_id;
          return html`
            <div
              key=${pack.registry_id}
              class="gallery-card ${pack.installed ? 'installed' : ''}"
              onClick=${() => setPreviewPack(pack)}
            >
              <div class="gallery-card-header">
                <span class="gallery-card-icon" style=${{ color: pack.color && /^#[0-9a-fA-F]{3,8}$/.test(pack.color) ? pack.color : undefined }}>${pack.icon || '◉'}</span>
                <div class="gallery-card-title-wrap">
                  <span class="gallery-card-name">${pack.name}</span>
                  ${pack.installed && !pack.updateAvailable && html`
                    <span class="gallery-badge installed">Installed</span>
                  `}
                  ${pack.updateAvailable && html`
                    <span class="gallery-badge update">Update Available</span>
                  `}
                </div>
              </div>
              <div class="gallery-card-desc">${pack.description || ''}</div>
              <div class="gallery-card-meta">
                <span class="gallery-card-category">${pack.category}</span>
                ${pack.estimated_tokens > 0 && html`
                  <span class="gallery-card-tokens">${estimateTokens(pack)} tok</span>
                `}
                ${pack.requires_capabilities && pack.requires_capabilities.length > 0 && html`
                  <span class="gallery-card-caps">${pack.requires_capabilities.join(', ')}</span>
                `}
              </div>
              <div class="gallery-card-actions" onClick=${e => e.stopPropagation()}>
                ${!pack.installed && html`
                  <button
                    class="primary small"
                    disabled=${isInstalling}
                    onClick=${() => handleInstall(pack)}
                  >${isInstalling ? 'Installing...' : 'Install'}</button>
                `}
                ${pack.updateAvailable && html`
                  <button
                    class="primary small"
                    disabled=${isInstalling}
                    onClick=${() => handleUpdate(pack)}
                  >${isInstalling ? 'Updating...' : 'Update'}</button>
                `}
                ${pack.installed && !pack.updateAvailable && html`
                  <button class="ghost small" disabled>Installed</button>
                `}
              </div>
            </div>
          `;
        })}
      </div>

      <${PackPreviewModal}
        open=${!!previewPack}
        pack=${previewPack}
        onClose=${() => setPreviewPack(null)}
        onInstall=${handleInstall}
        onUpdate=${handleUpdate}
        installing=${installing}
      />
    </div>
  `;
}

function estimateTokens(pack) {
  if (!pack) return 0;
  const full = pack.prompt_full ? Math.ceil(pack.prompt_full.length / 4) : 0;
  return pack.estimated_tokens || full;
}
