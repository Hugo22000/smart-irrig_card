# Smart Irrigation Card

Carte Lovelace pour Home Assistant, compatible avec l'intégration [smart-irriga-V2](https://github.com/Hugo22000/smart-irriga-V2).

## Fonctionnalités

- **Détection automatique** des zones (aucune config d'entités nécessaire)
- **Mode par zone** : Manuel / Planifié / Humidité
- **Prochain arrosage** avec compte à rebours en temps réel
- **Jours planifiés** affichés sous forme de pastilles (mode Planifié)
- **Jauge d'humidité** avec seuil visuel (mode Humidité)
- **Bouton de déclenchement manuel** par zone
- **Vue hebdomadaire** récapitulant tous les arrosages planifiés
- Compatible avec l'éditeur visuel de Lovelace

## Installation via HACS

1. Ouvrez HACS dans Home Assistant
2. Allez dans **Frontend → Explorer et télécharger des dépôts**
3. Recherchez `Smart Irrigation Card`
4. Cliquez sur **Télécharger**
5. Rechargez la page

## Installation manuelle

1. Téléchargez `smart-irrig-card.js`
2. Copiez-le dans `config/www/`
3. Dans Lovelace → **Ressources**, ajoutez :
   ```
   URL  : /local/smart-irrig-card.js
   Type : Module JavaScript
   ```
   Ou, si installé via HACS :
   ```
   URL  : /hacsfiles/smart-irrig_card/smart-irrig-card.js
   Type : Module JavaScript
   ```

## Utilisation

Ajoutez la carte dans votre tableau de bord :

```yaml
type: custom:smart-irrig-card
title: Mon Irrigation        # optionnel (défaut : "Irrigation Intelligente")
show_weekly_view: true       # optionnel (défaut : true)
```

La carte découvre automatiquement toutes les zones créées par l'intégration smart-irriga-V2.

## Prérequis

- Home Assistant ≥ 2025.8.0
- Intégration [smart-irriga-V2](https://github.com/Hugo22000/smart-irriga-V2) installée et configurée

## Entités utilisées par zone

| Entité | Usage |
|--------|-------|
| `sensor.*_next_irrigation` | Prochain arrosage + mode + config |
| `button.*_start_irrigation` | Déclenchement manuel |
| `sensor.*_water_volume` | Volume total consommé |
