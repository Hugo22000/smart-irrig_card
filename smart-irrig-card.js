// Smart Irrigation Card — compatible smart-irriga-V2
// Détecte automatiquement les zones via l'attribut activation_mode

const DAYS_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const DAYS_FULL  = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

const MODE_CFG = {
  manual:   { label: 'Manuel',   icon: 'mdi:hand-back-right', css: 'mode-manual'   },
  schedule: { label: 'Planifié', icon: 'mdi:calendar-clock',  css: 'mode-schedule' },
  humidity: { label: 'Humidité', icon: 'mdi:water-percent',   css: 'mode-humidity' },
};

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
  }

  connectedCallback() {
    // Mise à jour du compte à rebours toutes les minutes
    this._tid = setInterval(() => this._render(), 60_000);
  }

  disconnectedCallback() {
    clearInterval(this._tid);
  }

  set hass(hass) {
    this._hass = hass;
    this._updateZones();
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
    return Math.max(this._zones.length * 4, 2);
  }

  // ── Découverte des zones ─────────────────────────────────────────────────

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
          volumeId:          `sensor.${base}_water_volume`,
          displayName,
          mode:              st.attributes.activation_mode || 'manual',
          nextIrrigation:    st.state,
          scheduleTime:      st.attributes.schedule_time   ?? null,
          scheduleDays:      st.attributes.schedule_days   ?? [],
          humiditySensor:    st.attributes.humidity_sensor ?? null,
          humidityThreshold: st.attributes.humidity_threshold ?? 40,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
  }

  // ── Formatage date/heure ─────────────────────────────────────────────────

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

      if (diffMs < 0)     return { text: 'En cours…', urgent: true };
      if (diffMin < 60)   return { text: `Dans ${diffMin} min`, urgent: true };
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

  // ── Rendu HTML ───────────────────────────────────────────────────────────

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

    // Boutons de déclenchement manuel
    this.shadowRoot.querySelectorAll('[data-trigger]').forEach(btn => {
      btn.addEventListener('click', () => {
        const eid = btn.dataset.trigger;
        if (!this._hass.states[eid]) return;
        this._hass.callService('button', 'press', { entity_id: eid });
        btn.classList.add('pressed');
        btn.textContent = '✓ Démarré';
        setTimeout(() => {
          btn.classList.remove('pressed');
          btn.innerHTML = '<ha-icon icon="mdi:water-pump"></ha-icon> Démarrer maintenant';
        }, 3000);
      });
    });
  }

  // ─ Templates ─────────────────────────────────────────────────────────────

  _tplEmpty() {
    return `
      <div class="empty">
        <ha-icon icon="mdi:water-off-outline"></ha-icon>
        <p>Aucune zone détectée</p>
        <small>Configurez l'intégration <strong>smart-irriga-V2</strong></small>
      </div>`;
  }

  _tplZone(z) {
    const mc   = MODE_CFG[z.mode] ?? MODE_CFG.manual;
    const next = this._formatNext(z.nextIrrigation);
    const btn  = this._hass.states[z.buttonId];
    const vol  = this._hass.states[z.volumeId];
    const btnDisabled = !btn || btn.state === 'unavailable';

    return `
      <div class="zone-card">
        <div class="zone-head">
          <div class="zone-name">
            <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
            <span>${z.displayName}</span>
          </div>
          <div class="mode-badge ${mc.css}">
            <ha-icon icon="${mc.icon}"></ha-icon>
            <span>${mc.label}</span>
          </div>
        </div>

        <div class="zone-body">
          ${z.mode === 'schedule' ? this._tplSchedule(z) : ''}
          ${z.mode === 'humidity' ? this._tplHumidity(z) : ''}
          ${z.mode === 'manual'   ? this._tplManual()     : ''}

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
          <button class="trigger-btn" data-trigger="${z.buttonId}" ${btnDisabled ? 'disabled' : ''}>
            <ha-icon icon="mdi:water-pump"></ha-icon> Démarrer maintenant
          </button>
        </div>
      </div>`;
  }

  _tplSchedule(z) {
    return `
      <div class="sched-block">
        <div class="sched-time">
          <ha-icon icon="mdi:clock-outline"></ha-icon>
          <span>${z.scheduleTime ?? '--:--'}</span>
        </div>
        <div class="days-row">
          ${DAYS_FULL.map((d, i) => `
            <div class="day-dot ${z.scheduleDays.includes(d) ? 'active' : ''}" title="${d}">
              ${DAYS_SHORT[i]}
            </div>`).join('')}
        </div>
      </div>`;
  }

  _tplHumidity(z) {
    const st   = z.humiditySensor ? this._hass.states[z.humiditySensor] : null;
    const cur  = st ? parseFloat(st.state) : null;
    const valid = cur !== null && !isNaN(cur);
    const pct  = valid ? Math.min(Math.max(cur, 0), 100) : null;
    const low  = valid && cur < z.humidityThreshold;

    return `
      <div class="hum-block">
        <div class="hum-head">
          <div class="info-row" style="flex:1;margin:0">
            <ha-icon icon="mdi:water-percent"></ha-icon>
            <span>Seuil</span>
            <strong>${z.humidityThreshold}%</strong>
          </div>
          ${low       ? '<span class="badge warn">Arrosage requis</span>' : ''}
          ${valid && !low ? '<span class="badge ok">Humidité OK</span>'  : ''}
        </div>
        ${pct !== null ? `
        <div class="gauge-row">
          <span class="gauge-val">${Math.round(pct)}%</span>
          <div class="gauge-track">
            <div class="gauge-fill ${low ? 'low' : 'ok'}" style="width:${pct}%"></div>
            <div class="gauge-marker" style="left:${z.humidityThreshold}%" title="Seuil ${z.humidityThreshold}%"></div>
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
    const todayIdx = today === 0 ? 6 : today - 1; // Lun=0 … Dim=6

    return `
      <div class="weekly">
        <div class="weekly-title">
          <ha-icon icon="mdi:calendar-week"></ha-icon>
          <span>Planification hebdomadaire</span>
        </div>
        <div class="weekly-scroll">
          <div class="weekly-grid">
            <!-- en-tête jours -->
            <div class="wg-label"></div>
            ${DAYS_SHORT.map((d, i) => `
              <div class="wg-day${i === todayIdx ? ' today' : ''}">${d}</div>`).join('')}

            <!-- ligne par zone -->
            ${zones.map(z => `
              <div class="wg-zone" title="${z.displayName}">${z.displayName}</div>
              ${DAYS_FULL.map((day, i) => {
                const active = z.scheduleDays.includes(day);
                return `<div class="wg-cell${active ? ' active' : ''}${i === todayIdx ? ' today' : ''}">
                  ${active
                    ? `<span class="wg-time">${z.scheduleTime ?? '?'}</span>`
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

// Enregistrement pour l'éditeur visuel de Lovelace
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
  font-size: .65em; font-weight: 600; user-select: none; cursor: default;
  background: var(--secondary-background-color);
  color: var(--disabled-text-color, #9e9e9e);
  border: 1px solid var(--divider-color, rgba(0,0,0,.1));
}
.day-dot.active {
  background: var(--primary-color); color: white; border-color: var(--primary-color);
}

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
  position: absolute; top: -3px;
  width: 2px; height: calc(100% + 6px);
  background: rgba(244,67,54,.85); border-radius: 1px;
  transform: translateX(-1px);
}
.no-sensor { font-size: .8em; color: var(--secondary-text-color); font-style: italic; margin: 0; }

/* ── Mode manuel ── */
.manual-info {
  display: flex; align-items: center; gap: 8px;
  font-size: .85em; color: var(--secondary-text-color); font-style: italic;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06));
}

/* ── Pied de zone ── */
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
  opacity: .88; transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(0,0,0,.2);
}
.trigger-btn:active:not(:disabled), .trigger-btn.pressed {
  opacity: .7; transform: translateY(0); box-shadow: none;
}
.trigger-btn:disabled { opacity: .35; cursor: not-allowed; }

/* ── Vue hebdomadaire ── */
.weekly {
  border: 1px solid var(--divider-color, rgba(0,0,0,.1));
  border-radius: 12px; overflow: hidden;
}
.weekly-title {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  font-size: .9em; font-weight: 600; color: var(--primary-text-color);
  background: var(--secondary-background-color);
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
}
.weekly-title ha-icon { color: var(--primary-color); }
.weekly-scroll { overflow-x: auto; padding: 8px; }

.weekly-grid {
  display: grid;
  grid-template-columns: 110px repeat(7, 1fr);
  gap: 2px; min-width: 420px;
}
.wg-label  { padding: 4px; }
.wg-day    { text-align: center; font-size: .75em; font-weight: 600; color: var(--secondary-text-color); padding: 4px 2px; border-radius: 4px; }
.wg-day.today { color: var(--primary-color); font-weight: 700; }
.wg-zone   {
  font-size: .8em; font-weight: 500; color: var(--primary-text-color);
  padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wg-cell   {
  text-align: center; padding: 3px 2px; border-radius: 4px;
  min-height: 26px; display: flex; align-items: center; justify-content: center;
}
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
