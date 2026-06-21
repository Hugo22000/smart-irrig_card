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
    // Edit state : clé = sensorId, valeur = { mode, scheduleTime, scheduleDays, humidityThreshold, irrigationDuration }
    this._editingId   = null;
    this._pendingEdit = null;
    this._saving      = false;
    this._saveError   = null;
    this._manualActive  = {}; // sensorId -> { endTime }
    this._countdownTid  = null;
  }

  connectedCallback() {
    this._tid = setInterval(() => this._render(), 60_000);
  }

  disconnectedCallback() {
    clearInterval(this._tid);
    if (this._countdownTid) clearInterval(this._countdownTid);
  }

  set hass(hass) {
    this._hass = hass;
    this._updateZones();
    // Ne pas écraser le formulaire si l'utilisateur est en train de taper
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

  // ── Données ──────────────────────────────────────────────────────────────

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
          sensorId:          id,
          buttonId:          `button.${base}_start_irrigation`,
          stopButtonId:      `button.${base}_stop_irrigation`,
          volumeId:          `sensor.${base}_water_volume`,
          displayName,
          entryId:           st.attributes.entry_id ?? null,
          mode:              st.attributes.activation_mode || 'manual',
          nextIrrigation:    st.state,
          scheduleTime:      st.attributes.schedule_time   ?? null,
          scheduleDays:      st.attributes.schedule_days   ?? [],     // labels FR
          scheduleDaysRaw:   st.attributes.schedule_days_raw ?? [],   // codes mon/tue…
          humiditySensor:    st.attributes.humidity_sensor ?? null,
          humidityThreshold: st.attributes.humidity_threshold ?? 40,
          irrigationDuration: st.attributes.irrigation_duration ?? 300,
          irrigating:         st.attributes.irrigating          ?? false,
          pumpSwitches:       st.attributes.pump_switches       ?? [],
          totalFlowRate:      st.attributes.total_flow_rate     ?? null,
          zoneActive:         st.attributes.zone_active         ?? true,
          pumpsAvailable:     st.attributes.pumps_available     ?? null,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
  }

  // ── Formatage ────────────────────────────────────────────────────────────

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

  // ── Countdown arrosage manuel ────────────────────────────────────────────

  _startManual(zone) {
    this._manualActive[zone.sensorId] = { endTime: Date.now() + zone.irrigationDuration * 1000 };
    if (this._countdownTid) return;
    this._countdownTid = setInterval(() => {
      const now = Date.now();
      let hasActive = false;
      for (const [id, info] of Object.entries(this._manualActive)) {
        if (now < info.endTime) hasActive = true;
        else delete this._manualActive[id];
      }
      if (!hasActive) {
        clearInterval(this._countdownTid);
        this._countdownTid = null;
      }
      this._render();
    }, 1000);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  _startEdit(zone) {
    this._editingId = zone.sensorId;
    this._pendingEdit = {
      mode:              zone.mode,
      scheduleTime:      (zone.scheduleTime ?? '08:00').slice(0, 5),
      scheduleDays:      [...zone.scheduleDaysRaw],
      humidityThreshold: zone.humidityThreshold,
      irrigationDuration: zone.irrigationDuration,
    };
    this._saving    = false;
    this._saveError = null;
    this._render();
  }

  _cancelEdit() {
    this._editingId   = null;
    this._pendingEdit = null;
    this._saving      = false;
    this._saveError   = null;
    this._render();
  }

  async _saveEdit(zone) {
    if (!zone.entryId) {
      this._saveError = "entry_id manquant — installez la dernière version de smart-irriga-V2 via HACS.";
      this._render();
      return;
    }
    this._saving    = true;
    this._saveError = null;
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
      this._saveError   = null;
    } catch (err) {
      console.error('smart-irrig-card: save failed', err);
      this._saveError = `Erreur : service "${DOMAIN}.${SERVICE}" introuvable — vérifiez que smart-irriga-V2 est à jour.`;
    }
    this._saving = false;
    this._render();
  }

  // ── Toggles zones ────────────────────────────────────────────────────────

  _toggleZone(zone) {
    if (!zone.entryId) return;
    this._hass.callService(DOMAIN, SERVICE, {
      entry_id:            zone.entryId,
      activation_mode:     zone.mode,
      irrigation_duration: zone.irrigationDuration,
      zone_active:         !zone.zoneActive,
    });
  }

  _toggleAllZones() {
    const allActive = this._zones.every(z => z.zoneActive);
    for (const zone of this._zones) {
      if (!zone.entryId) continue;
      this._hass.callService(DOMAIN, SERVICE, {
        entry_id:            zone.entryId,
        activation_mode:     zone.mode,
        irrigation_duration: zone.irrigationDuration,
        zone_active:         !allActive,
      });
    }
  }

  // ── Rendu ────────────────────────────────────────────────────────────────

  _render() {
    if (!this._hass || !this._config) return;

    const { title, show_weekly_view } = this._config;
    const zones = this._zones;
    const schedZones = zones.filter(z => z.mode === 'schedule' && z.scheduleDays.length > 0);
    const allActive  = zones.length > 0 && zones.every(z => z.zoneActive);
    const someActive = zones.some(z => z.zoneActive);

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="card-header">
          <ha-icon icon="mdi:sprinkler"></ha-icon>
          <span>${title}</span>
          <span class="count-chip">${zones.length} zone${zones.length !== 1 ? 's' : ''}</span>
          ${zones.length > 0 ? `
          <div class="global-toggle-wrap" title="${allActive ? 'Désactiver toutes les zones' : 'Activer toutes les zones'}">
            <span class="global-toggle-label">Tout</span>
            <button class="zone-toggle${allActive ? ' on' : someActive ? ' partial' : ''}" data-global-toggle>
              <div class="zone-toggle-thumb"></div>
            </button>
          </div>` : ''}
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
    // Déclenchement manuel
    this.shadowRoot.querySelectorAll('[data-trigger]').forEach(btn => {
      btn.addEventListener('click', () => {
        const eid = btn.dataset.trigger;
        if (!this._hass.states[eid]) return;
        this._hass.callService('button', 'press', { entity_id: eid });
        btn.classList.add('pressed');
        btn.innerHTML = '<ha-icon icon="mdi:check"></ha-icon> Démarré';

        const zone = this._zones.find(z => z.buttonId === eid);
        if (zone && zone.mode === 'manual') this._startManual(zone);

        setTimeout(() => {
          btn.classList.remove('pressed');
          btn.innerHTML = '<ha-icon icon="mdi:water-pump"></ha-icon> Démarrer maintenant';
        }, 3000);
      });
    });

    // Arrêt manuel
    this.shadowRoot.querySelectorAll('[data-stop]').forEach(btn => {
      btn.addEventListener('click', () => {
        const eid = btn.dataset.stop;
        if (this._hass.states[eid]) {
          this._hass.callService('button', 'press', { entity_id: eid });
        }
        const zone = this._zones.find(z => z.stopButtonId === eid);
        if (zone) {
          delete this._manualActive[zone.sensorId];
          if (!Object.keys(this._manualActive).length && this._countdownTid) {
            clearInterval(this._countdownTid);
            this._countdownTid = null;
          }
        }
        this._render();
      });
    });

    // Toggles zone active (planifié / humidité)
    this.shadowRoot.querySelectorAll('[data-zone-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const z = this._zones.find(z => z.sensorId === btn.dataset.zoneToggle);
        if (z) this._toggleZone(z);
      });
    });

    // Toggle global
    const globalBtn = this.shadowRoot.querySelector('[data-global-toggle]');
    if (globalBtn) globalBtn.addEventListener('click', () => this._toggleAllZones());

    // Boutons modifier / annuler / sauvegarder
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

    // Formulaire d'édition — sélecteur de mode
    this.shadowRoot.querySelectorAll('[data-mode-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this._pendingEdit) {
          this._pendingEdit.mode = btn.dataset.modeBtn;
          this._render();
        }
      });
    });

    // Pastilles jours (édition)
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

    // Inputs directs (heure, seuil, durée)
    const bindInput = (sel, field, transform = v => v) => {
      const el = this.shadowRoot.querySelector(sel);
      if (el) el.addEventListener('input', () => {
        if (this._pendingEdit) this._pendingEdit[field] = transform(el.value);
      });
    };
    bindInput('#edit-time', 'scheduleTime');

    // Humidité : mise à jour du % affiché en direct
    const humEl  = this.shadowRoot.querySelector('#edit-humidity');
    const humVal = this.shadowRoot.querySelector('.range-val');
    if (humEl) {
      humEl.addEventListener('input', () => {
        if (!this._pendingEdit) return;
        this._pendingEdit.humidityThreshold = Number(humEl.value);
        if (humVal) humVal.textContent = humEl.value + '%';
      });
    }

    // Durée : mise à jour + recalcul volume en direct
    const durEl  = this.shadowRoot.querySelector('#edit-duration');
    const volHint = this.shadowRoot.querySelector('#vol-hint');
    const editingZone = this._zones.find(z => z.sensorId === this._editingId);
    if (durEl) {
      durEl.addEventListener('input', () => {
        if (!this._pendingEdit) return;
        this._pendingEdit.irrigationDuration = Number(durEl.value);
        if (volHint && editingZone && editingZone.totalFlowRate !== null) {
          const v = Math.round(editingZone.totalFlowRate * Number(durEl.value) / 6);
          volHint.textContent = '≈ ' + (v >= 1000 ? (v / 1000).toFixed(1) + ' L' : v + ' mL');
        }
      });
    }
  }

  // ── Templates ────────────────────────────────────────────────────────────

  _tplEmpty() {
    return `
      <div class="empty">
        <ha-icon icon="mdi:water-off-outline"></ha-icon>
        <p>Aucune zone détectée</p>
        <small>Configurez l'intégration <strong>smart-irriga-V2</strong></small>
      </div>`;
  }

  _tplZone(z) {
    const isEditing     = this._editingId === z.sensorId;
    const mc            = MODE_CFG[z.mode] ?? MODE_CFG.manual;
    const next          = this._formatNext(z.nextIrrigation);
    const btn           = this._hass.states[z.buttonId];
    const vol           = this._hass.states[z.volumeId];
    const pumpsUnavailable = z.pumpsAvailable === false;
    const btnDis        = !btn || btn.state === 'unavailable' || pumpsUnavailable;
    const canEdit       = !!z.entryId;
    const clientActive  = !!this._manualActive[z.sensorId] && Date.now() < this._manualActive[z.sensorId].endTime;
    const anyPumpOn     = z.pumpSwitches.some(sw => this._hass.states[sw]?.state === 'on');
    const isPumping     = z.irrigating || clientActive || anyPumpOn;

    return `
      <div class="zone-card${isEditing ? ' editing' : ''}${isPumping ? ' pumping' : ''}${pumpsUnavailable ? ' offline' : ''}">
        <div class="zone-head">
          <div class="zone-name">
            <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
            <span>${z.displayName}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${pumpsUnavailable ? `<span class="offline-badge"><ha-icon icon="mdi:wifi-off"></ha-icon> Hors ligne</span>` : ''}
            ${isPumping && !pumpsUnavailable ? `<span class="irrigating-badge"><ha-icon icon="mdi:water-pump"></ha-icon> Arrosage</span>` : ''}
            <div class="mode-badge ${mc.css}">
              <ha-icon icon="${mc.icon}"></ha-icon>
              <span>${mc.label}</span>
            </div>
            ${!isEditing ? `
            <button class="icon-btn${canEdit ? '' : ' warn'}"
              data-edit="${z.sensorId}"
              title="${canEdit ? 'Modifier la planification' : 'Éditer (mise à jour smart-irriga-V2 requise)'}">
              <ha-icon icon="mdi:pencil"></ha-icon>
            </button>` : ''}
          </div>
        </div>

        ${isEditing ? this._tplEditForm(z) : this._tplZoneBody(z, next, btn, vol, btnDis, clientActive, anyPumpOn, pumpsUnavailable)}
      </div>`;
  }

  _tplZoneBody(z, next, btn, vol, btnDis, clientActive = false, anyPumpOn = false, pumpsUnavailable = false) {
    const isPumping = z.irrigating || clientActive || anyPumpOn;
    return `
      <div class="zone-body">
        ${z.mode === 'schedule' ? this._tplSchedule(z, next) : ''}
        ${z.mode === 'humidity' ? this._tplHumidity(z) : ''}
        ${z.mode === 'manual'   ? this._tplManual(z, clientActive, anyPumpOn) : ''}

        ${this._tplPumpStatus(z, clientActive, pumpsUnavailable)}

        ${vol && vol.state !== 'unavailable' ? `
        <div class="info-row">
          <ha-icon icon="mdi:water-outline"></ha-icon>
          <span>Volume total</span>
          <strong>${parseFloat(vol.state).toLocaleString('fr-FR')} ${vol.attributes.unit_of_measurement ?? 'mL'}</strong>
        </div>` : ''}
      </div>

      <div class="zone-foot">
        ${z.mode === 'manual' ? `
          ${pumpsUnavailable ? `
          <div class="pump-offline-banner">
            <ha-icon icon="mdi:wifi-off"></ha-icon>
            <span>ESP32 hors ligne — arrosage indisponible</span>
          </div>` : ''}
          <div class="foot-btn-row">
            <button class="trigger-btn" data-trigger="${z.buttonId}" ${btnDis ? 'disabled' : ''}>
              <ha-icon icon="mdi:water-pump"></ha-icon> Démarrer
            </button>
            <button class="stop-btn" data-stop="${z.stopButtonId}" ${!isPumping ? 'disabled' : ''}
              title="Arrêter l'arrosage">
              <ha-icon icon="mdi:stop-circle-outline"></ha-icon> Arrêter
            </button>
          </div>
        ` : `
          ${isPumping ? `
          <button class="stop-btn stop-btn-full" data-stop="${z.stopButtonId}" title="Arrêter l'arrosage">
            <ha-icon icon="mdi:stop-circle-outline"></ha-icon> Arrêter l'arrosage en cours
          </button>` : ''}
          <div class="zone-active-row${isPumping ? ' with-stop' : ''}">
            <span class="zone-active-label">
              <ha-icon icon="${z.zoneActive ? 'mdi:check-circle-outline' : 'mdi:pause-circle-outline'}"></ha-icon>
              ${z.zoneActive ? 'Automatisation active' : 'Automatisation pausée'}
            </span>
            <button class="zone-toggle${z.zoneActive ? ' on' : ''}" data-zone-toggle="${z.sensorId}"
              title="${z.zoneActive ? 'Désactiver cette zone' : 'Activer cette zone'}">
              <div class="zone-toggle-thumb"></div>
            </button>
          </div>
        `}
      </div>`;
  }

  _tplPumpStatus(z, clientActive = false, pumpsUnavailable = false) {
    if (!z.pumpSwitches.length && z.pumpsAvailable === null) return '';
    if (pumpsUnavailable) {
      const chips = z.pumpSwitches.length
        ? z.pumpSwitches.map(sw => {
            const name = this._hass.states[sw]?.attributes.friendly_name || sw;
            return `<div class="pump-chip offline" title="${sw}">
              <ha-icon icon="mdi:pump-off"></ha-icon>
              ${name}
            </div>`;
          }).join('')
        : `<div class="pump-chip offline"><ha-icon icon="mdi:pump-off"></ha-icon> Pompe(s) hors ligne</div>`;
      return `<div class="pump-row">${chips}</div>`;
    }
    if (!z.pumpSwitches.length) return '';
    const chips = z.pumpSwitches.map((sw) => {
      const st   = this._hass.states[sw];
      const on   = (st && st.state === 'on') || clientActive;
      const name = (st && st.attributes.friendly_name) || sw;
      return `<div class="pump-chip${on ? ' on' : ''}" title="${sw}">
        <ha-icon icon="${on ? 'mdi:pump' : 'mdi:pump-off'}"></ha-icon>
        ${name}
      </div>`;
    }).join('');
    return `<div class="pump-row">${chips}</div>`;
  }

  _tplEditForm(z) {
    const ed = this._pendingEdit;
    if (!ed) return '';
    const canSave = !!z.entryId;

    return `
      <div class="edit-form">
        <div class="edit-section-title">
          <ha-icon icon="mdi:cog"></ha-icon> Modifier la planification
        </div>

        ${!canSave ? `
        <div class="edit-warn">
          <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
          <div><strong>Mise à jour requise</strong><br>
          <small>Installez la dernière version de <em>smart-irriga-V2</em> via HACS pour activer la sauvegarde.</small></div>
        </div>` : ''}

        ${this._saveError ? `
        <div class="edit-error">
          <ha-icon icon="mdi:alert-circle"></ha-icon>
          <span>${this._saveError}</span>
        </div>` : ''}

        <!-- Sélecteur de mode -->
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

        <!-- Durée (tous modes) -->
        <div class="field-row">
          <label class="field-label" for="edit-duration">Durée (secondes)</label>
          <input type="number" id="edit-duration" class="field-input"
            min="1" max="3600" step="1"
            value="${ed.irrigationDuration}" />
          ${z.totalFlowRate !== null ? `
          <span class="vol-hint" id="vol-hint">≈ ${(() => {
            const v = Math.round(z.totalFlowRate * ed.irrigationDuration / 6);
            return v >= 1000 ? (v / 1000).toFixed(1) + ' L' : v + ' mL';
          })()}</span>` : ''}
        </div>

        <!-- Options planification -->
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

        <!-- Options humidité -->
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

        <!-- Boutons -->
        <div class="edit-actions">
          <button class="btn-cancel" data-cancel="${z.sensorId}">
            <ha-icon icon="mdi:close"></ha-icon> Annuler
          </button>
          <button class="btn-save${this._saving ? ' saving' : ''}" data-save="${z.sensorId}"
            ${(this._saving || !canSave) ? 'disabled' : ''}>
            <ha-icon icon="${this._saving ? 'mdi:loading' : 'mdi:check'}"></ha-icon>
            ${this._saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>`;
  }

  _tplSchedule(z, next) {
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
        <div class="sched-next${next.urgent ? ' urgent' : ''}">
          <ha-icon icon="mdi:calendar-arrow-right"></ha-icon>
          <span>${next.text}</span>
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

  _tplManual(z, clientActive = false, anyPumpOn = false) {
    const dur = z.irrigationDuration;
    const fr  = z.totalFlowRate;
    const vol = fr !== null ? Math.round(fr * dur / 6) : null;
    const volStr = vol !== null
      ? (vol >= 1000 ? (vol / 1000).toFixed(1) + ' L' : vol + ' mL')
      : null;

    if (clientActive) {
      const info      = this._manualActive[z.sensorId];
      const remaining = Math.max(0, Math.ceil((info.endTime - Date.now()) / 1000));
      const pct       = Math.round((remaining / dur) * 100);
      return `
        <div class="manual-active">
          <div class="manual-active-header">
            <ha-icon icon="mdi:water-pump"></ha-icon>
            <span>Arrosage en cours…</span>
            <span class="manual-countdown">${remaining} s</span>
          </div>
          <div class="manual-progress-track">
            <div class="manual-progress-fill" style="width:${pct}%"></div>
          </div>
          ${volStr !== null ? `<span class="manual-vol-est"><ha-icon icon="mdi:water-outline"></ha-icon> ${volStr} estimés</span>` : ''}
        </div>`;
    }

    if (anyPumpOn || z.irrigating) {
      return `
        <div class="manual-active">
          <div class="manual-active-header">
            <ha-icon icon="mdi:water-pump"></ha-icon>
            <span>Pompes actives</span>
            <span class="pump-on-badge">En cours</span>
          </div>
          ${volStr !== null ? `<span class="manual-vol-est"><ha-icon icon="mdi:water-outline"></ha-icon> ${volStr} estimés</span>` : ''}
        </div>`;
    }

    return `
      <div class="manual-info">
        <ha-icon icon="mdi:information-outline"></ha-icon>
        <span>Mode manuel — déclenchez l'arrosage via le bouton ci-dessous</span>
      </div>
      ${volStr !== null ? `
      <div class="info-row">
        <ha-icon icon="mdi:water-outline"></ha-icon>
        <span>Volume estimé (${dur} s)</span>
        <strong>${volStr}</strong>
      </div>` : ''}`;
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

// ── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
:host { display: block; }
ha-card { overflow: hidden; }

/* ── En-tête carte ── */
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

/* ── Contenu ── */
.card-content {
  padding: 12px 16px 16px;
  display: flex; flex-direction: column; gap: 12px;
}

/* ── Zone card ── */
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

/* ── Badge mode ── */
.mode-badge {
  display: flex; align-items: center; gap: 4px;
  font-size: .75em; font-weight: 600;
  padding: 3px 10px; border-radius: 20px;
}
.mode-manual  { background: rgba(255,152,0,.12); color: #e65100; border: 1px solid rgba(255,152,0,.35); }
.mode-schedule{ background: rgba(76,175,80,.12);  color: #2e7d32; border: 1px solid rgba(76,175,80,.35); }
.mode-humidity{ background: rgba(33,150,243,.12); color: #1565c0; border: 1px solid rgba(33,150,243,.35); }

/* ── Bouton icône ── */
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
  background: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}
.icon-btn.disabled { opacity: .35; cursor: not-allowed; }

/* ── Corps de zone ── */
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
.info-row.urgent ha-icon,
.info-row.urgent strong { color: var(--warning-color, #ff9800); }

/* ── Planification ── */
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
.day-dot.active {
  background: var(--primary-color); color: white; border-color: var(--primary-color);
}
.day-dot.clickable { cursor: pointer; transition: transform .1s, box-shadow .1s; }
.day-dot.clickable:hover { transform: scale(1.15); box-shadow: 0 2px 6px rgba(0,0,0,.2); }

/* ── Humidité ── */
.hum-block {
  display: flex; flex-direction: column; gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
}
.hum-head { display: flex; align-items: center; gap: 8px; }
.badge {
  font-size: .7em; font-weight: 600; padding: 2px 8px;
  border-radius: 10px; white-space: nowrap;
}
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

/* ── Mode manuel ── */
.manual-info {
  display: flex; align-items: center; gap: 8px;
  font-size: .85em; color: var(--secondary-text-color); font-style: italic;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
}

/* ── Toggle switch zone / global ── */
.zone-active-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
}
.zone-active-label {
  display: flex; align-items: center; gap: 6px;
  font-size: .875em; font-weight: 500; color: var(--secondary-text-color);
}
.zone-active-label ha-icon { --mdc-icon-size: 18px; color: var(--primary-color); }

.zone-toggle {
  flex-shrink: 0; width: 44px; height: 24px; border-radius: 12px;
  background: var(--divider-color, #bdbdbd);
  border: none; cursor: pointer; position: relative;
  transition: background .25s; padding: 0;
}
.zone-toggle.on { background: var(--primary-color); }
.zone-toggle.partial { background: rgba(var(--rgb-primary-color, 33,150,243),.45); }
.zone-toggle-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 20px; height: 20px; border-radius: 50%;
  background: white; transition: transform .25s;
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
  pointer-events: none;
}
.zone-toggle.on .zone-toggle-thumb,
.zone-toggle.partial .zone-toggle-thumb { transform: translateX(20px); }

/* Toggle global dans l'en-tête */
.global-toggle-wrap {
  display: flex; align-items: center; gap: 6px; margin-left: auto;
}
.global-toggle-label {
  font-size: .75em; font-weight: 500; color: var(--secondary-text-color);
}
.global-toggle-wrap .zone-toggle { width: 36px; height: 20px; }
.global-toggle-wrap .zone-toggle-thumb { width: 16px; height: 16px; }
.global-toggle-wrap .zone-toggle.on .zone-toggle-thumb,
.global-toggle-wrap .zone-toggle.partial .zone-toggle-thumb { transform: translateX(16px); }

/* ── Arrosage manuel en cours ── */
.manual-active {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(33,150,243,.08); border: 1px solid rgba(33,150,243,.3);
  margin-bottom: 2px;
}
.manual-active-header {
  display: flex; align-items: center; gap: 8px;
  font-size: .875em; font-weight: 600; color: var(--primary-color);
}
.manual-active-header ha-icon { --mdc-icon-size: 18px; animation: spin-pump .9s linear infinite; }
@keyframes spin-pump { to { transform: rotate(360deg); } }
.manual-countdown {
  margin-left: auto; font-size: 1.1em; font-weight: 700;
  color: var(--primary-color); font-variant-numeric: tabular-nums;
}
.manual-progress-track {
  height: 6px; border-radius: 3px;
  background: var(--secondary-background-color);
  border: 1px solid rgba(33,150,243,.2); overflow: hidden;
}
.manual-progress-fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--primary-color), #42a5f5);
  transition: width .95s linear;
}
.manual-vol-est {
  display: flex; align-items: center; gap: 4px;
  font-size: .78em; color: var(--secondary-text-color);
}
.manual-vol-est ha-icon { --mdc-icon-size: 14px; }
.pump-on-badge {
  margin-left: auto; font-size: .78em; font-weight: 700;
  padding: 2px 8px; border-radius: 10px;
  background: rgba(76,175,80,.15); color: #2e7d32;
  border: 1px solid rgba(76,175,80,.4);
  animation: blink-badge 1.4s ease-in-out infinite;
}

/* ── Pied de zone ── */
.zone-foot {
  padding: 10px 14px;
  border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
  background: var(--secondary-background-color);
}
.foot-btn-row {
  display: flex; gap: 8px;
}
.trigger-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 9px 16px;
  background: var(--primary-color); color: var(--text-primary-color, #fff);
  border: none; border-radius: 8px;
  font-size: .875em; font-weight: 600; letter-spacing: .02em;
  cursor: pointer; transition: opacity .2s, transform .1s, box-shadow .15s;
  font-family: inherit;
}
.stop-btn {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 14px;
  background: rgba(244,67,54,.1); color: #c62828;
  border: 1px solid rgba(244,67,54,.35); border-radius: 8px;
  font-size: .875em; font-weight: 600;
  cursor: pointer; transition: opacity .2s, background .15s;
  font-family: inherit; white-space: nowrap;
}
.stop-btn:hover:not(:disabled) {
  background: rgba(244,67,54,.2);
}
.stop-btn:disabled { opacity: .3; cursor: not-allowed; }
.stop-btn-full {
  width: 100%; margin-bottom: 8px;
  border-top: none;
}
.zone-active-row.with-stop {
  border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
  padding-top: 8px; margin-top: 0;
}
.trigger-btn:hover:not(:disabled) {
  opacity: .88; transform: translateY(-1px); box-shadow: 0 3px 8px rgba(0,0,0,.2);
}
.trigger-btn:active:not(:disabled), .trigger-btn.pressed { opacity: .7; transform: translateY(0); }
.trigger-btn:disabled { opacity: .35; cursor: not-allowed; }

/* ── Formulaire d'édition ── */
.edit-form {
  padding: 14px;
  display: flex; flex-direction: column; gap: 14px;
  background: var(--card-background-color);
}
.edit-section-title {
  display: flex; align-items: center; gap: 6px;
  font-size: .85em; font-weight: 600; color: var(--primary-color);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
}
.field-row {
  display: flex; flex-direction: column; gap: 6px;
}
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

/* Sélecteur de mode */
.mode-selector {
  display: flex; gap: 6px; flex-wrap: wrap;
}
.mode-sel-btn {
  flex: 1; min-width: 80px;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 8px 10px;
  border: 1px solid var(--divider-color, rgba(0,0,0,.15));
  border-radius: 8px;
  background: var(--secondary-background-color);
  color: var(--secondary-text-color);
  font-size: .8em; font-weight: 500;
  cursor: pointer; transition: all .15s;
  font-family: inherit;
}
.mode-sel-btn:hover { border-color: var(--primary-color); color: var(--primary-color); }
.mode-sel-btn.active {
  background: var(--primary-color);
  color: var(--text-primary-color, white);
  border-color: var(--primary-color);
  font-weight: 600;
}

/* Boutons annuler / sauvegarder */
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
  background: var(--secondary-background-color);
  color: var(--secondary-text-color);
  border: 1px solid var(--divider-color, rgba(0,0,0,.15));
}
.btn-cancel:hover { background: var(--divider-color); }
.btn-save {
  background: var(--primary-color);
  color: var(--text-primary-color, white);
}
.btn-save:hover:not(:disabled) { opacity: .88; transform: translateY(-1px); }
.btn-save:disabled, .btn-save.saving { opacity: .6; cursor: not-allowed; }

/* ── Avertissements / erreurs formulaire ── */
.icon-btn.warn { border-color: var(--warning-color, #ff9800); color: var(--warning-color, #ff9800); }
.icon-btn.warn:hover { background: var(--warning-color, #ff9800); color: white; border-color: var(--warning-color, #ff9800); }

.edit-warn {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(255,152,0,.1); border: 1px solid rgba(255,152,0,.35);
  font-size: .85em; color: #b56900; line-height: 1.4;
}
.edit-warn ha-icon { color: #ff9800; flex-shrink: 0; margin-top: 2px; }

.edit-error {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(244,67,54,.1); border: 1px solid rgba(244,67,54,.35);
  font-size: .85em; color: #c62828; line-height: 1.4;
}
.edit-error ha-icon { color: #f44336; flex-shrink: 0; }

/* ── Pompes ── */
.zone-card.pumping {
  border-color: var(--primary-color);
  animation: pulse-pump 2s ease-in-out infinite;
}
@keyframes pulse-pump {
  0%, 100% { box-shadow: 0 0 0 2px rgba(33,150,243,.15), 0 1px 3px rgba(0,0,0,.06); }
  50%       { box-shadow: 0 0 0 4px rgba(33,150,243,.3),  0 2px 8px rgba(0,0,0,.1);  }
}

.irrigating-badge {
  display: flex; align-items: center; gap: 4px;
  font-size: .72em; font-weight: 600; white-space: nowrap;
  padding: 3px 8px; border-radius: 10px;
  background: rgba(33,150,243,.12); color: var(--primary-color);
  border: 1px solid rgba(33,150,243,.35);
  animation: blink-badge 1.4s ease-in-out infinite;
}
@keyframes blink-badge { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

.pump-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
}
.pump-chip {
  display: flex; align-items: center; gap: 4px;
  font-size: .75em; font-weight: 500;
  padding: 3px 10px; border-radius: 12px;
  background: var(--secondary-background-color);
  color: var(--secondary-text-color);
  border: 1px solid var(--divider-color, rgba(0,0,0,.12));
}
.pump-chip.on {
  background: rgba(76,175,80,.12); color: #2e7d32;
  border-color: rgba(76,175,80,.4);
}
.pump-chip.offline {
  background: rgba(244,67,54,.08); color: #c62828;
  border-color: rgba(244,67,54,.3);
}
.pump-chip ha-icon { --mdc-icon-size: 16px; }

/* ── Zone hors ligne ── */
.zone-card.offline {
  border-color: rgba(244,67,54,.5);
  opacity: .85;
}
.offline-badge {
  display: flex; align-items: center; gap: 4px;
  font-size: .72em; font-weight: 600; white-space: nowrap;
  padding: 3px 8px; border-radius: 10px;
  background: rgba(244,67,54,.12); color: #c62828;
  border: 1px solid rgba(244,67,54,.35);
}
.pump-offline-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 6px; margin-bottom: 6px;
  background: rgba(244,67,54,.08); border: 1px solid rgba(244,67,54,.25);
  font-size: .82em; color: #c62828;
}
.pump-offline-banner ha-icon { --mdc-icon-size: 16px; flex-shrink: 0; }

/* ── Prochain arrosage (bloc planifié) ── */
.sched-next {
  display: flex; align-items: center; gap: 6px;
  font-size: .82em; color: var(--secondary-text-color);
  padding-top: 6px; width: 100%;
}
.sched-next.urgent { color: var(--warning-color, #ff9800); font-weight: 600; }
.sched-next ha-icon { flex-shrink: 0; }

/* ── Hint volume dans le formulaire ── */
.vol-hint {
  font-size: .8em; font-weight: 600; color: var(--primary-color);
  padding-top: 2px;
}

/* ── Vue hebdomadaire ── */
.weekly {
  border: 1px solid var(--divider-color, rgba(0,0,0,.1));
  border-radius: 12px; overflow: hidden;
}
.weekly-title {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  font-size: .9em; font-weight: 600; color: var(--primary-text-color);
  background: var(--secondary-background-color);
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
}
.weekly-title ha-icon { color: var(--primary-color); }
.weekly-scroll { overflow-x: auto; padding: 8px; }

.weekly-grid {
  display: grid; grid-template-columns: 110px repeat(7, 1fr);
  gap: 2px; min-width: 420px;
}
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

/* ── État vide ── */
.empty {
  display: flex; flex-direction: column; align-items: center;
  padding: 36px 16px; text-align: center;
  color: var(--secondary-text-color); gap: 8px;
}
.empty ha-icon { --mdc-icon-size: 48px; opacity: .3; }
.empty p { margin: 0; font-size: 1em; font-weight: 500; color: var(--primary-text-color); }
.empty small { font-size: .85em; opacity: .75; }
`;
