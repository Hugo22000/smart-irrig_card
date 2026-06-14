// Smart Irrigation Card — compatible smart-irriga-V2
// Détecte automatiquement les zones via l'attribut activation_mode

const DAYS_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const DAYS_FULL  = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const DAYS_CODE  = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const MODE_CFG = {
  manual:   { label: 'Manuel',   icon: 'mdi:hand-back-right', css: 'mode-manual'   },
  schedule: { label: 'Planifié', icon: 'mdi:calendar-clock',  css: 'mode-schedule' },
  humidity: { label: 'Humidité', icon: 'mdi:water-percent',   css: 'mode-humidity' },
};

const DOMAIN = 'smart_irriga_v2';
const SERVICE = 'set_zone_options';

// ── Éditeur de config (visual editor) ───────────────────────────────────────

class SmartIrrigCardEditor extends HTMLElement {
  set hass(_) {}

  setConfig(config) {
    this._config = config;
    this._render();
  }

  _render() {
    if (this._rendered) return;
    this._rendered = true;

    this.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
        <label style="font-size:.875em;color:var(--secondary-text-color)">
          Titre de la carte
          <input type="text" id="title"
            value="${this._config?.title ?? ''}"
            placeholder="Irrigation Intelligente"
            style="display:block;margin-top:4px;width:100%;padding:8px;box-sizing:border-box;
                   border:1px solid var(--divider-color);border-radius:6px;
                   background:var(--card-background-color);color:var(--primary-text-color);font-size:1em"/>
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:.875em;color:var(--secondary-text-color);cursor:pointer">
          <input type="checkbox" id="weekly" ${this._config?.show_weekly_view !== false ? 'checked' : ''}/>
          Afficher la planification hebdomadaire
        </label>
      </div>
    `;

    const emit = () => {
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: {
          config: {
            ...this._config,
            title: this.querySelector('#title').value,
            show_weekly_view: this.querySelector('#weekly').checked,
          },
        },
        bubbles: true,
        composed: true,
      }));
    };

    this.querySelector('#title').addEventListener('change', emit);
    this.querySelector('#weekly').addEventListener('change', emit);
  }
}

customElements.define('smart-irrig-card-editor', SmartIrrigCardEditor);

// ── Carte principale ─────────────────────────────────────────────────────────

class SmartIrrigCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._zones = [];
    this._tid   = null;
    this._editingId   = null;
    this._pendingEdit = null;
    this._saving      = false;
  }

  connectedCallback() {
    this._tid = setInterval(() => this._render(), 60_000);
  }

  disconnectedCallback() {
    clearInterval(this._tid);
  }

  set hass(hass) {
    this._hass = hass;
    this._updateZones();
    const focused = this.shadowRoot.activeElement;
    if (focused && ['INPUT', 'SELECT', 'TEXTAREA'].includes(focused.tagName)) return;
    this._render();
  }

  setConfig(config) {
    this._config = {
      title: 'Irrigation Intelligente',
      show_weekly_view: true,
      ...config,
    };
    this._render();
  }

  static getConfigElement() {
    return document.createElement('smart-irrig-card-editor');
  }

  static getStubConfig() {
    return { title: 'Irrigation Intelligente', show_weekly_view: true };
  }

  getCardSize() {
    return Math.max(this._zones.length * 5, 2);
  }

  _updateZones() {
    if (!this._hass) return;

    this._zones = Object.entries(this._hass.states)
      .filter(([id, st]) =>
        id.startsWith('sensor.') &&
        id.endsWith('_next_irrigation') &&
        st.attributes.activation_mode !== undefined
      )
      .map(([id, st]) => {
        const base = id.slice('sensor.'.length, -'_next_irrigation'.length);

        const rawName = (st.attributes.friendly_name ?? '')
          .replace(/\s*(Next Irrigation|Prochaine Irrigation)\s*/i, '')
          .trim();
        const displayName = rawName
          ? rawName.charAt(0).toUpperCase() + rawName.slice(1)
          : base.replace(/_/g, ' ');

        return {
          sensorId:           id,
          buttonId:           `button.${base}_start_irrigation`,
          volumeId:           `sensor.${base}_water_volume`,
          displayName,
          entryId:            st.attributes.entry_id ?? null,
          mode:               st.attributes.activation_mode || 'manual',
          nextIrrigation:     st.state,
          scheduleTime:       st.attributes.schedule_time   ?? null,
          scheduleDays:       st.attributes.schedule_days   ?? [],
          scheduleDaysRaw:    st.attributes.schedule_days_raw ?? [],
          humiditySensor:     st.attributes.humidity_sensor ?? null,
          humidityThreshold:  st.attributes.humidity_threshold ?? 40,
          irrigationDuration: st.attributes.irrigation_duration ?? 300,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
  }

  _formatNext(iso) {
    if (!iso || ['unavailable', 'unknown', 'none', 'null'].includes(iso)) {
      return { text: 'Non planifié', urgent: false };
    }
    try {
      const date = new Date(iso);
      if (isNaN(date)) return { text: iso, urgent: false };

      const diffMs   = date - Date.now();
      const diffMin  = Math.floor(diffMs / 60_000);
      const diffHour = Math.floor(diffMs / 3_600_000);
      const diffDay  = Math.floor(diffMs / 86_400_000);

      if (diffMs < 0)    return { text: 'En cours…', urgent: true };
      if (diffMin < 60)  return { text: `Dans ${diffMin} min`, urgent: true };
      if (diffHour < 24) {
        const m = diffMin % 60;
        return { text: `Dans ${diffHour}h${m > 0 ? m : ''}`, urgent: diffHour < 2 };
      }
      if (diffDay === 1) {
        const t = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        return { text: `Demain à ${t}`, urgent: false };
      }
      const txt = date.toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit',
      });
      return { text: txt.charAt(0).toUpperCase() + txt.slice(1), urgent: false };
    } catch {
      return { text: iso, urgent: false };
    }
  }

  _startEdit(zone) {
    this._editingId = zone.sensorId;
    this._pendingEdit = {
      mode:               zone.mode,
      scheduleTime:       (zone.scheduleTime ?? '08:00').slice(0, 5),
      scheduleDays:       [...zone.scheduleDaysRaw],
      humidityThreshold:  zone.humidityThreshold,
      irrigationDuration: zone.irrigationDuration,
    };
    this._saving = false;
    this._render();
  }

  _cancelEdit() {
    this._editingId   = null;
    this._pendingEdit = null;
    this._saving      = false;
    this._render();
  }

  async _saveEdit(zone) {
    if (!zone.entryId) {
      alert('Impossible de sauvegarder : entry_id manquant. Mettez à jour smart-irriga-V2.');
      return;
    }
    this._saving = true;
    this._render();

    const ed = this._pendingEdit;
    const serviceData = {
      entry_id:            zone.entryId,
      activation_mode:     ed.mode,
      irrigation_duration: Number(ed.irrigationDuration),
    };

    if (ed.mode === 'schedule') {
      serviceData.schedule_time = ed.scheduleTime.length === 5
        ? ed.scheduleTime + ':00'
        : ed.scheduleTime;
      serviceData.schedule_days = ed.scheduleDays;
    } else if (ed.mode === 'humidity') {
      serviceData.humidity_threshold = Number(ed.humidityThreshold);
    }

    try {
      await this._hass.callService(DOMAIN, SERVICE, serviceData);
      this._editingId   = null;
      this._pendingEdit = null;
    } catch (err) {
      console.error('smart-irrig-card: save failed', err);
    }
    this._saving = false;
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;

    const { title, show_weekly_view } = this._config;
    const zones = this._zones;
    const schedZones = zones.filter(z => z.mode === 'schedule' && z.scheduleDays.length > 0);

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="card-header">
          <ha-icon icon="mdi:sprinkler"></ha-icon>
          <span>${title}</span>
          <span class="count-chip">${zones.length} zone${zones.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="card-content">
          ${zones.length === 0 ? this._tplEmpty() : zones.map(z => this._tplZone(z)).join('')}
          ${show_weekly_view && schedZones.length > 0 ? this._tplWeekly(schedZones) : ''}
        </div>
      </ha-card>
    `;

    this._bindEvents();
  }

  _bindEvents() {
    this.shadowRoot.querySelectorAll('[data-trigger]').forEach(btn => {
      btn.addEventListener('click', () => {
        const eid = btn.dataset.trigger;
        if (!this._hass.states[eid]) return;
        this._hass.callService('button', 'press', { entity_id: eid });
        btn.classList.add('pressed');
        btn.innerHTML = '<ha-icon icon="mdi:check"></ha-icon> Démarré';
        setTimeout(() => {
          btn.classList.remove('pressed');
          btn.innerHTML = '<ha-icon icon="mdi:water-pump"></ha-icon> Démarrer maintenant';
        }, 3000);
      });
    });

    this.shadowRoot.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const z = this._zones.find(z => z.sensorId === btn.dataset.edit);
        if (z) this._startEdit(z);
      });
    });

    this.shadowRoot.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', () => this._cancelEdit());
    });

    this.shadowRoot.querySelectorAll('[data-save]').forEach(btn => {
      btn.addEventListener('click', () => {
        const z = this._zones.find(z => z.sensorId === btn.dataset.save);
        if (z) this._saveEdit(z);
      });
    });

    this.shadowRoot.querySelectorAll('[data-mode-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this._pendingEdit) {
          this._pendingEdit.mode = btn.dataset.modeBtn;
          this._render();
        }
      });
    });

    this.shadowRoot.querySelectorAll('[data-day-toggle]').forEach(dot => {
      dot.addEventListener('click', () => {
        if (!this._pendingEdit) return;
        const code = dot.dataset.dayToggle;
        const days = this._pendingEdit.scheduleDays;
        const idx  = days.indexOf(code);
        if (idx >= 0) days.splice(idx, 1);
        else days.push(code);
        this._render();
      });
    });

    const bindInput = (sel, field, transform = v => v) => {
      const el = this.shadowRoot.querySelector(sel);
      if (el) el.addEventListener('input', () => {
        if (this._pendingEdit) this._pendingEdit[field] = transform(el.value);
      });
    };
    bindInput('#edit-time',     'scheduleTime');
    bindInput('#edit-humidity', 'humidityThreshold', Number);
    bindInput('#edit-duration', 'irrigationDuration', Number);
  }

  _tplEmpty() {
    return `
      <div class="empty">
        <ha-icon icon="mdi:water-off-outline"></ha-icon>
        <p>Aucune zone détectée</p>
        <small>Configurez l'intégration <strong>smart-irriga-V2</strong></small>
      </div>`;
  }

  _tplZone(z) {
    const isEditing = this._editingId === z.sensorId;
    const mc        = MODE_CFG[z.mode] ?? MODE_CFG.manual;
    const next      = this._formatNext(z.nextIrrigation);
    const btn       = this._hass.states[z.buttonId];
    const vol       = this._hass.states[z.volumeId];
    const btnDis    = !btn || btn.state === 'unavailable';
    const canEdit   = !!z.entryId;

    return `
      <div class="zone-card${isEditing ? ' editing' : ''}">
        <div class="zone-head">
          <div class="zone-name">
            <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
            <span>${z.displayName}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="mode-badge ${mc.css}">
              <ha-icon icon="${mc.icon}"></ha-icon>
              <span>${mc.label}</span>
            </div>
            ${!isEditing ? `
            <button class="icon-btn${canEdit ? '' : ' disabled'}"
              data-edit="${z.sensorId}"
              title="${canEdit ? 'Modifier la planification' : 'Mettez à jour smart-irriga-V2 pour activer l\'édition'}"
              ${canEdit ? '' : 'disabled'}>
              <ha-icon icon="mdi:pencil"></ha-icon>
            </button>` : ''}
          </div>
        </div>

        ${isEditing ? this._tplEditForm(z) : this._tplZoneBody(z, next, btn, vol, btnDis)}
      </div>`;
  }

  _tplZoneBody(z, next, btn, vol, btnDis) {
    return `
      <div class="zone-body">
        ${z.mode === 'schedule' ? this._tplSchedule(z) : ''}
        ${z.mode === 'humidity' ? this._tplHumidity(z) : ''}
        ${z.mode === 'manual'   ? this._tplManual()    : ''}

        <div class="info-row${next.urgent ? ' urgent' : ''}">
          <ha-icon icon="mdi:calendar-clock"></ha-icon>
          <span>Prochain arrosage</span>
          <strong>${next.text}</strong>
        </div>

        ${vol && vol.state !== 'unavailable' ? `
        <div class="info-row">
          <ha-icon icon="mdi:water-outline"></ha-icon>
          <span>Volume total</span>
          <strong>${parseFloat(vol.state).toLocaleString('fr-FR')} ${vol.attributes.unit_of_measurement ?? 'mL'}</strong>
        </div>` : ''}
      </div>

      <div class="zone-foot">
        <button class="trigger-btn" data-trigger="${z.buttonId}" ${btnDis ? 'disabled' : ''}>
          <ha-icon icon="mdi:water-pump"></ha-icon> Démarrer maintenant
        </button>
      </div>`;
  }

  _tplEditForm(z) {
    const ed = this._pendingEdit;
    if (!ed) return '';

    return `
      <div class="edit-form">
        <div class="edit-section-title">
          <ha-icon icon="mdi:cog"></ha-icon> Modifier la planification
        </div>

        <div class="field-row">
          <label class="field-label">Mode</label>
          <div class="mode-selector">
            ${['manual', 'schedule', 'humidity'].map(m => `
              <button class="mode-sel-btn${ed.mode === m ? ' active' : ''}" data-mode-btn="${m}">
                <ha-icon icon="${MODE_CFG[m].icon}"></ha-icon>
                ${MODE_CFG[m].label}
              </button>`).join('')}
          </div>
        </div>

        <div class="field-row">
          <label class="field-label" for="edit-duration">Durée (secondes)</label>
          <input type="number" id="edit-duration" class="field-input"
            min="10" max="3600" step="10"
            value="${ed.irrigationDuration}" />
        </div>

        ${ed.mode === 'schedule' ? `
        <div class="field-row">
          <label class="field-label" for="edit-time">Heure</label>
          <input type="time" id="edit-time" class="field-input"
            value="${ed.scheduleTime}" />
        </div>
        <div class="field-row">
          <label class="field-label">Jours</label>
          <div class="days-row">
            ${DAYS_CODE.map((code, i) => `
              <div class="day-dot${ed.scheduleDays.includes(code) ? ' active' : ''} clickable"
                data-day-toggle="${code}" title="${DAYS_FULL[i]}">
                ${DAYS_SHORT[i]}
              </div>`).join('')}
          </div>
        </div>` : ''}

        ${ed.mode === 'humidity' ? `
        <div class="field-row">
          <label class="field-label" for="edit-humidity">Seuil humidité (%)</label>
          <div style="display:flex;align-items:center;gap:10px">
            <input type="range" id="edit-humidity" class="field-range"
              min="0" max="100" step="5"
              value="${ed.humidityThreshold}" />
            <span class="range-val">${ed.humidityThreshold}%</span>
          </div>
        </div>` : ''}

        <div class="edit-actions">
          <button class="btn-cancel" data-cancel="${z.sensorId}">
            <ha-icon icon="mdi:close"></ha-icon> Annuler
          </button>
          <button class="btn-save${this._saving ? ' saving' : ''}" data-save="${z.sensorId}"
            ${this._saving ? 'disabled' : ''}>
            <ha-icon icon="${this._saving ? 'mdi:loading' : 'mdi:check'}"></ha-icon>
            ${this._saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>`;
  }

  _tplSchedule(z) {
    return `
      <div class="sched-block">
        <div class="sched-time">
          <ha-icon icon="mdi:clock-outline"></ha-icon>
          <span>${(z.scheduleTime ?? '--:--').slice(0, 5)}</span>
        </div>
        <div class="days-row">
          ${DAYS_CODE.map((code, i) => `
            <div class="day-dot${z.scheduleDaysRaw.includes(code) ? ' active' : ''}" title="${DAYS_FULL[i]}">
              ${DAYS_SHORT[i]}
            </div>`).join('')}
        </div>
      </div>`;
  }

  _tplHumidity(z) {
    const st    = z.humiditySensor ? this._hass.states[z.humiditySensor] : null;
    const cur   = st ? parseFloat(st.state) : null;
    const valid = cur !== null && !isNaN(cur);
    const pct   = valid ? Math.min(Math.max(cur, 0), 100) : null;
    const low   = valid && cur < z.humidityThreshold;

    return `
      <div class="hum-block">
        <div class="hum-head">
          <div class="info-row" style="flex:1;margin:0">
            <ha-icon icon="mdi:water-percent"></ha-icon>
            <span>Seuil</span>
            <strong>${z.humidityThreshold}%</strong>
          </div>
          ${low        ? '<span class="badge warn">Arrosage requis</span>' : ''}
          ${valid && !low ? '<span class="badge ok">Humidité OK</span>'   : ''}
        </div>
        ${pct !== null ? `
        <div class="gauge-row">
          <span class="gauge-val">${Math.round(pct)}%</span>
          <div class="gauge-track">
            <div class="gauge-fill ${low ? 'low' : 'ok'}" style="width:${pct}%"></div>
            <div class="gauge-marker" style="left:${z.humidityThreshold}%"></div>
          </div>
        </div>` : `<p class="no-sensor">Capteur d'humidité non disponible</p>`}
      </div>`;
  }

  _tplManual() {
    return `
      <div class="manual-info">
        <ha-icon icon="mdi:information-outline"></ha-icon>
        <span>Mode manuel — déclenchez l'arrosage via le bouton ci-dessous</span>
      </div>`;
  }

  _tplWeekly(zones) {
    const today    = new Date().getDay();
    const todayIdx = today === 0 ? 6 : today - 1;

    return `
      <div class="weekly">
        <div class="weekly-title">
          <ha-icon icon="mdi:calendar-week"></ha-icon>
          <span>Planification hebdomadaire</span>
        </div>
        <div class="weekly-scroll">
          <div class="weekly-grid">
            <div class="wg-label"></div>
            ${DAYS_SHORT.map((d, i) => `
              <div class="wg-day${i === todayIdx ? ' today' : ''}">${d}</div>`).join('')}

            ${zones.map(z => `
              <div class="wg-zone" title="${z.displayName}">${z.displayName}</div>
              ${DAYS_CODE.map((code, i) => {
                const active = z.scheduleDaysRaw.includes(code);
                return `<div class="wg-cell${active ? ' active' : ''}${i === todayIdx ? ' today' : ''}">
                  ${active
                    ? `<span class="wg-time">${(z.scheduleTime ?? '?').slice(0, 5)}</span>`
                    : `<span class="wg-dot">·</span>`}
                </div>`;
              }).join('')}
            `).join('')}
          </div>
        </div>
      </div>`;
  }
}

customElements.define('smart-irrig-card', SmartIrrigCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type:             'smart-irrig-card',
  name:             'Smart Irrigation Card',
  description:      "Carte de gestion de l'irrigation intelligente (smart-irriga-V2)",
  preview:          false,
  documentationURL: 'https://github.com/Hugo22000/smart-irrig_card',
});

const STYLES = `
:host { display: block; }
ha-card { overflow: hidden; }

.card-header {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 16px 0;
  font-size: 1.05em; font-weight: 500;
  color: var(--primary-text-color);
}
.card-header ha-icon { color: var(--primary-color); }
.count-chip {
  margin-left: auto; font-size: .78em; font-weight: 400;
  padding: 2px 10px; border-radius: 10px;
  background: var(--secondary-background-color);
  color: var(--secondary-text-color);
}

.card-content {
  padding: 12px 16px 16px;
  display: flex; flex-direction: column; gap: 12px;
}

.zone-card {
  border: 1px solid var(--divider-color, rgba(0,0,0,.12));
  border-radius: 12px; overflow: hidden;
  background: var(--card-background-color);
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
  transition: box-shadow .2s;
}
.zone-card.editing {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px rgba(var(--rgb-primary-color, 33,150,243),.15), 0 2px 8px rgba(0,0,0,.1);
}

.zone-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px;
  background: var(--secondary-background-color);
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
}
.zone-name {
  display: flex; align-items: center; gap: 8px;
  font-weight: 600; font-size: .95em;
  color: var(--primary-text-color);
}
.zone-name ha-icon { color: var(--primary-color); }

.mode-badge {
  display: flex; align-items: center; gap: 4px;
  font-size: .75em; font-weight: 600;
  padding: 3px 10px; border-radius: 20px;
}
.mode-manual  { background: rgba(255,152,0,.12); color: #e65100; border: 1px solid rgba(255,152,0,.35); }
.mode-schedule{ background: rgba(76,175,80,.12);  color: #2e7d32; border: 1px solid rgba(76,175,80,.35); }
.mode-humidity{ background: rgba(33,150,243,.12); color: #1565c0; border: 1px solid rgba(33,150,243,.35); }

.icon-btn {
  width: 30px; height: 30px; border-radius: 50%;
  border: 1px solid var(--divider-color, rgba(0,0,0,.15));
  background: transparent; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--secondary-text-color);
  transition: background .15s, color .15s;
  padding: 0;
}
.icon-btn:hover:not(:disabled) {
  background: var(--primary-color); color: white; border-color: var(--primary-color);
}
.icon-btn.disabled { opacity: .35; cursor: not-allowed; }

.zone-body {
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.info-row {
  display: flex; align-items: center; gap: 6px;
  font-size: .875em; color: var(--secondary-text-color);
}
.info-row ha-icon { flex-shrink: 0; color: var(--secondary-text-color); }
.info-row strong  { margin-left: auto; font-weight: 600; color: var(--primary-text-color); }
.info-row.urgent  { color: var(--warning-color, #ff9800); }
.info-row.urgent ha-icon, .info-row.urgent strong { color: var(--warning-color, #ff9800); }

.sched-block {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
}
.sched-time {
  display: flex; align-items: center; gap: 6px;
  font-size: 1.4em; font-weight: 700; color: var(--primary-color);
  min-width: 80px;
}
.days-row { display: flex; gap: 4px; flex-wrap: wrap; }
.day-dot {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: .65em; font-weight: 600; user-select: none;
  background: var(--secondary-background-color);
  color: var(--disabled-text-color, #9e9e9e);
  border: 1px solid var(--divider-color, rgba(0,0,0,.1));
  cursor: default;
}
.day-dot.active { background: var(--primary-color); color: white; border-color: var(--primary-color); }
.day-dot.clickable { cursor: pointer; transition: transform .1s, box-shadow .1s; }
.day-dot.clickable:hover { transform: scale(1.15); box-shadow: 0 2px 6px rgba(0,0,0,.2); }

.hum-block {
  display: flex; flex-direction: column; gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
}
.hum-head { display: flex; align-items: center; gap: 8px; }
.badge { font-size: .7em; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.badge.warn { background: rgba(255,152,0,.2); color: #e65100; border: 1px solid rgba(255,152,0,.4); }
.badge.ok   { background: rgba(76,175,80,.2);  color: #2e7d32; border: 1px solid rgba(76,175,80,.4); }

.gauge-row { display: flex; align-items: center; gap: 8px; }
.gauge-val  { font-size: .85em; font-weight: 600; min-width: 38px; text-align: right; color: var(--primary-text-color); }
.gauge-track {
  flex: 1; height: 8px; border-radius: 4px;
  background: var(--secondary-background-color);
  border: 1px solid var(--divider-color, rgba(0,0,0,.1));
  position: relative; overflow: visible;
}
.gauge-fill { height: 100%; border-radius: 4px; max-width: 100%; transition: width .4s ease; }
.gauge-fill.ok  { background: linear-gradient(90deg, var(--primary-color), #42a5f5); }
.gauge-fill.low { background: linear-gradient(90deg, #ff9800, #f44336); }
.gauge-marker {
  position: absolute; top: -3px; width: 2px; height: calc(100% + 6px);
  background: rgba(244,67,54,.85); border-radius: 1px; transform: translateX(-1px);
}
.no-sensor { font-size: .8em; color: var(--secondary-text-color); font-style: italic; margin: 0; }

.manual-info {
  display: flex; align-items: center; gap: 8px;
  font-size: .85em; color: var(--secondary-text-color); font-style: italic;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
}

.zone-foot {
  padding: 10px 14px;
  border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
  background: var(--secondary-background-color);
}
.trigger-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 9px 16px;
  background: var(--primary-color); color: var(--text-primary-color, #fff);
  border: none; border-radius: 8px;
  font-size: .875em; font-weight: 600; letter-spacing: .02em;
  cursor: pointer; transition: opacity .2s, transform .1s, box-shadow .15s;
  font-family: inherit;
}
.trigger-btn:hover:not(:disabled) {
  opacity: .88; transform: translateY(-1px); box-shadow: 0 3px 8px rgba(0,0,0,.2);
}
.trigger-btn:active:not(:disabled), .trigger-btn.pressed { opacity: .7; transform: translateY(0); }
.trigger-btn:disabled { opacity: .35; cursor: not-allowed; }

.edit-form {
  padding: 14px; display: flex; flex-direction: column; gap: 14px;
  background: var(--card-background-color);
}
.edit-section-title {
  display: flex; align-items: center; gap: 6px;
  font-size: .85em; font-weight: 600; color: var(--primary-color);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
}
.field-row { display: flex; flex-direction: column; gap: 6px; }
.field-label {
  font-size: .8em; font-weight: 600; color: var(--secondary-text-color);
  text-transform: uppercase; letter-spacing: .05em;
}
.field-input {
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--divider-color, rgba(0,0,0,.15));
  background: var(--secondary-background-color);
  color: var(--primary-text-color);
  font-size: .9em; font-family: inherit;
  width: 100%; box-sizing: border-box;
}
.field-input:focus { outline: none; border-color: var(--primary-color); }
.field-range { width: 100%; accent-color: var(--primary-color); cursor: pointer; }
.range-val { font-size: .9em; font-weight: 600; color: var(--primary-text-color); min-width: 40px; }

.mode-selector { display: flex; gap: 6px; flex-wrap: wrap; }
.mode-sel-btn {
  flex: 1; min-width: 80px;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 8px 10px;
  border: 1px solid var(--divider-color, rgba(0,0,0,.15));
  border-radius: 8px;
  background: var(--secondary-background-color);
  color: var(--secondary-text-color);
  font-size: .8em; font-weight: 500;
  cursor: pointer; transition: all .15s; font-family: inherit;
}
.mode-sel-btn:hover { border-color: var(--primary-color); color: var(--primary-color); }
.mode-sel-btn.active {
  background: var(--primary-color); color: var(--text-primary-color, white);
  border-color: var(--primary-color); font-weight: 600;
}

.edit-actions {
  display: flex; gap: 8px; justify-content: flex-end;
  padding-top: 6px;
  border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
}
.btn-cancel, .btn-save {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 8px;
  font-size: .875em; font-weight: 600;
  cursor: pointer; border: none; font-family: inherit;
  transition: opacity .15s, transform .1s;
}
.btn-cancel {
  background: var(--secondary-background-color); color: var(--secondary-text-color);
  border: 1px solid var(--divider-color, rgba(0,0,0,.15));
}
.btn-cancel:hover { background: var(--divider-color); }
.btn-save { background: var(--primary-color); color: var(--text-primary-color, white); }
.btn-save:hover:not(:disabled) { opacity: .88; transform: translateY(-1px); }
.btn-save:disabled, .btn-save.saving { opacity: .6; cursor: not-allowed; }

.weekly { border: 1px solid var(--divider-color, rgba(0,0,0,.1)); border-radius: 12px; overflow: hidden; }
.weekly-title {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  font-size: .9em; font-weight: 600; color: var(--primary-text-color);
  background: var(--secondary-background-color);
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
}
.weekly-title ha-icon { color: var(--primary-color); }
.weekly-scroll { overflow-x: auto; padding: 8px; }
.weekly-grid { display: grid; grid-template-columns: 110px repeat(7, 1fr); gap: 2px; min-width: 420px; }
.wg-label  { padding: 4px; }
.wg-day    { text-align: center; font-size: .75em; font-weight: 600; color: var(--secondary-text-color); padding: 4px 2px; border-radius: 4px; }
.wg-day.today { color: var(--primary-color); font-weight: 700; }
.wg-zone   { font-size: .8em; font-weight: 500; color: var(--primary-text-color); padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wg-cell   { text-align: center; padding: 3px 2px; border-radius: 4px; min-height: 26px; display: flex; align-items: center; justify-content: center; }
.wg-cell.today  { background: rgba(0,0,0,.04); }
.wg-cell.active { background: rgba(76,175,80,.12); }
.wg-cell.active.today { background: rgba(76,175,80,.25); }
.wg-time   { font-size: .7em; font-weight: 700; color: var(--primary-color); }
.wg-dot    { color: var(--disabled-text-color, #bdbdbd); font-size: 1.1em; }

.empty {
  display: flex; flex-direction: column; align-items: center;
  padding: 36px 16px; text-align: center;
  color: var(--secondary-text-color); gap: 8px;
}
.empty ha-icon { --mdc-icon-size: 48px; opacity: .3; }
.empty p { margin: 0; font-size: 1em; font-weight: 500; color: var(--primary-text-color); }
.empty small { font-size: .85em; opacity: .75; }
`;
