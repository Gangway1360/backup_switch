[Uploading README.md…]()
# 📂 Explorateur de configs

Interface web **100 % locale** pour parcourir, lire et rechercher des fichiers de configuration de switchs (**HP/Aruba ProCurve** et **Alcatel-Lucent OmniSwitch**) stockés sur un dossier ou un lecteur réseau.

- Aucun serveur, aucune installation, aucune dépendance : 3 fichiers statiques (`index.html`, `style.css`, `app.js`).
- Lecture seule : les fichiers sont lus directement par le navigateur, rien n'est envoyé nulle part.
- Pensé pour un lecteur réseau monté sous Windows (`Z:\configs`) rempli de sauvegardes de configuration (exports CatTools, `show running-config`, `vcboot.cfg`…).

## Démarrage rapide

1. Télécharge le dépôt (ou les 3 fichiers) dans un dossier quelconque.
2. Ouvre `index.html` dans ton navigateur (double-clic, `file://` fonctionne).
3. Clique sur **Choisir un dossier…** et sélectionne le répertoire qui contient les configs.

Le dossier des configs n'a pas besoin d'être à côté de l'outil : l'outil lit le dossier que tu sélectionnes.

## Fonctionnalités

### Navigation
- Arborescence par dossiers avec fil d'Ariane, filtre rapide sur les noms de fichiers.
- Colonne de gauche redimensionnable (largeur mémorisée), noms de fichiers complets (retour à la ligne, taille et date en dessous).
- Mise en page adaptée aux fenêtres étroites (colonnes empilées).

### Visionneuse
- **Affichage virtualisé** : seules les lignes visibles existent dans la page, donc un fichier de plusieurs dizaines de milliers de lignes défile aussi fluidement qu'un petit.
- Numéros de ligne, recherche dans le fichier avec surlignage et compteur d'occurrences.
- Boutons **Copier** et **Télécharger**.
- **Coloration syntaxique** : commentaires, chaînes, adresses IP, numéros, ports, mots-clés, commandes de négation (`no`, `shutdown`, `disable`…). Le numéro de `vlan` / `interface` est mis en évidence.
- Détection automatique du constructeur (badge dans l'en-tête) : ProCurve / ArubaOS-Switch, OmniSwitch ou générique.

### Sections repliables
| Constructeur | Ce qui est repliable |
|---|---|
| **ProCurve / ArubaOS-Switch** | Chaque bloc indenté (`vlan N`, `interface X`, `router ospf`…), et les séries de blocs ou de commandes consécutives de même famille : « vlan (12 blocs) », « snmp-server (7 lignes) »… |
| **OmniSwitch** | Les sections `! VLAN :`, `! IP :`… et, à l'intérieur, les lignes regroupées par objet (`vlan 1551`, `interfaces 1/1/1`, `ip interface`) puis par famille de commande. |
| **Autre** | Blocs par indentation. |

- Boutons **Tout replier** / **Tout déplier**.
- Un saut vers une ligne (depuis les résultats de recherche) ou une recherche dans le fichier **déplie automatiquement** les sections concernées.
- Au-delà de 200 000 lignes, la coloration et le repli sont désactivés.

### Recherche plein texte
- Sur tout l'arbre ou seulement le dossier courant.
- Options : **regex**, **respect de la casse**, **noms de fichiers seuls**.
- Résultats **regroupés par fichier**, avec un compteur d'occurrences, des groupes repliables et un surlignage des correspondances. Un clic ouvre le fichier à la bonne ligne.
- Exports **CSV** :
  - *CSV résultats* : fichier, ligne, texte ;
  - *CSV fichiers* : fichier, nombre d'occurrences (pratique pour répondre à « quels switchs portent le VLAN 1551 ? »).
- Recherche interruptible, indicateur de progression.

### Tableau de bord (📊)
Synthèse du parc à partir des configs du dossier courant (ou de tout l'arbre si « dossier courant » est décoché) :

- **Indicateurs** : équipements, switchs physiques (un stack ou un Virtual Chassis compte pour plusieurs unités), modèles distincts, ports, switchs PoE, versions de firmware.
- **Répartitions cliquables** : constructeur, modèle, nombre de ports par switch, PoE / non PoE, firmware, topologie (autonome / stack / Virtual Chassis), VLAN les plus présents.
- **Détail** : un clic sur une barre liste les équipements correspondants (hostname, modèle, ports, PoE, firmware, IP, lien vers la config). Export **CSV** de la liste affichée.
- **Dernière sauvegarde par équipement** (activé par défaut) : si le dossier contient plusieurs sauvegardes du même switch, seule la plus récente est comptée (clé : constructeur + hostname).

**D'où viennent les informations** (par ordre de priorité) :

| Information | Source |
|---|---|
| Modèle | catalogue utilisateur → table intégrée → règles (hostname / fichier) → référence produit lue dans la config |
| Nombre de ports | catalogue / règle → estimation d'après les ports cités dans la config (ProCurve uniquement, arrondie à la classe 8/12/16/24/48) |
| PoE | catalogue / règle → nom du modèle contenant « PoE » → présence de commandes PoE dans la config (`power-over-ethernet…`, `lanpower…`) |
| Firmware | en-tête ProCurve (`Created on release #…`) |
| Stack / VC | blocs `stacking … member N type "…"` (ProCurve), `virtual-chassis chassis-id N` ou ports `1/…`, `2/…` (OmniSwitch) |

Les configs ne contiennent pas toujours le modèle exact, le nombre de ports ni le PoE (**l'absence de commande PoE ne prouve pas l'absence de PoE**). Ces cas apparaissent comme « Modèle inconnu », « Non renseigné » ou « Indéterminé », avec un bandeau d'avertissement. Pour les lever, complète le **catalogue matériel** (bouton *Catalogue matériel…*) :

```json
{
  "models": {
    "J4899B": { "name": "HP ProCurve 2650", "ports": 48, "poe": false }
  },
  "rules": [
    { "match": "^SW-IDF", "on": "host", "name": "OS6860E-P48", "ports": 48, "poe": true }
  ]
}
```

- `models` : par référence produit (celle de l'en-tête ou du bloc `stacking`).
- `rules` : par expression régulière sur le hostname (`"on": "host"`), le chemin du fichier (`"on": "file"`) ou les deux (par défaut). Utile pour OmniSwitch, dont les configs n'indiquent pas le modèle.
- Le bouton *Ajouter les références non identifiées* pré-remplit le catalogue avec les références détectées, à compléter.
- Le catalogue est enregistré dans le navigateur (`localStorage`) ; import / export en JSON pour le partager ou le sauvegarder.
- `ports` = ports d'accès (classe 24 / 48), hors uplinks.

La table intégrée ne contient que quelques références courantes (Aruba/HP 2530, 2920, 2930F, 2810). **Elle est à vérifier** ; le catalogue utilisateur est toujours prioritaire.

### Confort
- Croix **×** dans les champs de saisie (et `Échap`) pour les vider.
- Thème clair / sombre automatique (selon le système).
- Mémorisation du dernier dossier ouvert (Chrome / Edge).
- Case **cache disque** et bouton **🧹 Cache** (voir *Performances*).

## Performances

- **Ouverture d'un gros dossier** : l'arborescence est énumérée sans lire les fichiers ; taille et date sont chargées à la demande, seulement pour le dossier affiché.
- **Visionneuse virtualisée** : environ 90 lignes sont rendues à la fois, quelle que soit la taille du fichier. Replier ou déplier une section ne recrée pas la page, et l'en-tête cliqué reste à sa place à l'écran.
- **Recherche** : chaque fichier est d'abord testé en un seul passage ; il n'est découpé en lignes que s'il contient une correspondance. Le travail est fait par petites tranches de temps pour que l'interface reste réactive, et la recherche est interruptible.
- **Cache de contenu** : les fichiers lus sont gardés en mémoire (environ 120 Mo, les moins récents sont évincés en premier) et revalidés par taille et date. Les recherches suivantes ne relisent donc plus le partage. Un survol prolongé d'un fichier le précharge avant le clic.
- **Cache disque (optionnel, désactivé par défaut)** : la case *cache disque* conserve aussi le contenu dans IndexedDB, ce qui accélère les recherches d'une session à l'autre. Comme les configs contiennent des secrets, active-le seulement si ta politique de sécurité l'autorise. Décocher la case ou cliquer sur **🧹 Cache** efface tout.
- Listes de fichiers longues : rendu différé hors écran (`content-visibility`), tri et comparaison de noms pré-calculés.

## Compatibilité navigateurs

| Navigateur | Sélection du dossier | Dernier dossier mémorisé |
|---|---|---|
| Chrome / Edge | API File System Access | ✅ (bouton « Rouvrir ») |
| Firefox | `<input webkitdirectory>` | ❌ (re-sélection à chaque ouverture) |

Sous Firefox, un message du type « Envoyer N fichiers ? » peut s'afficher. **Rien n'est envoyé** : la lecture reste locale.

## Formats reconnus

- **ProCurve / ArubaOS-Switch** : `running-config` avec en-tête `; J9772A Configuration Editor; Created on release #…`, blocs indentés terminés par `exit`.
- **OmniSwitch (AOS)** : configuration snapshot avec sections `! Titre :` et commandes à plat (`vlan 1551 members port 1/1/1 tagged`, `ip interface "…" address … mask … vlan …`).
- **Autres** : lecture, recherche et repli par indentation.

Les fichiers sont décodés en UTF-8, avec repli automatique sur Windows-1252.

## Limites

- **Lecture seule** : aucune modification des fichiers.
- Les fichiers **binaires** ou de plus de **8 Mo** sont ignorés (affichage comme recherche).
- La recherche est plafonnée à **2 000 résultats**.
- La visionneuse étant virtualisée, `Ctrl+F` du navigateur ne voit que les lignes affichées : utilise le champ **Chercher dans le fichier**. La sélection à la souris fonctionne sur les lignes affichées ; pour tout récupérer, utilise **Copier**.
- Chrome / Edge refusent de sélectionner la **racine d'un lecteur** (`Z:\`) ou certains dossiers système : choisis un sous-répertoire (`Z:\configs`).
- Sur un partage réseau, la première recherche relit les fichiers via SMB et peut prendre quelques secondes.
- Tableau de bord : le nombre de ports d'un **OmniSwitch** n'est pas estimé (les ports du VLAN par défaut ne figurent pas dans la config) : renseigne-le via une règle du catalogue. Les switchs sans commande PoE dans leur config restent « Indéterminé » tant que le modèle n'est pas identifié.
- Le tableau de bord lit tous les fichiers du périmètre choisi (le cache accélère les analyses suivantes).
- La détection du format s'appuie sur les syntaxes ProCurve et OmniSwitch courantes. Une syntaxe atypique se lit normalement mais peut ne pas bénéficier de tous les regroupements de sections.

## Hébergement (optionnel)

L'outil fonctionne très bien ouvert en local. Pour le servir depuis un serveur web :

- **HTTPS obligatoire** : sans contexte sécurisé, Chrome et Edge désactivent le sélecteur de dossier.
- Seul **le code** (3 fichiers statiques) est hébergé. Les configs restent sur le poste de l'utilisateur et ne transitent jamais par le serveur.
- Exemple Nginx qui interdit à la page toute requête réseau :

```nginx
location /configs/ {
    alias /var/www/config_browser/;
    add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
}
```

> ⚠️ Vérifie que ta politique de sécurité autorise l'exécution de code chargé depuis un site externe sur un poste qui manipule des données sensibles. Dans le doute, garde simplement une copie des 3 fichiers en local.

## Sécurité et vie privée

- Aucune requête réseau : ni analytics, ni CDN, ni police externe.
- Les données restent dans le navigateur. Par défaut, seuls le dernier dossier (IndexedDB), la largeur de la colonne et le catalogue matériel (localStorage) sont mémorisés. Le contenu des fichiers n'est conservé sur disque que si tu actives *cache disque*.
- Le contenu des fichiers est toujours échappé avant affichage.
- Les exports CSV neutralisent les débuts de cellule pouvant être interprétés comme des formules par Excel (`=`, `+`, `-`, `@`).
- Les configs contiennent souvent des secrets (communautés SNMP, mots de passe, clés RADIUS) : pense-y avant de partager une capture ou un export.

## Structure

```
config_browser/
├── index.html   # structure de la page
├── style.css    # thème clair/sombre, coloration, sections repliables, résultats, tableau de bord
└── app.js       # sources de fichiers, caches, analyse, coloration, repli, visionneuse virtualisée, recherche, CSV
```

Dans `app.js`, les grandes parties sont, dans l'ordre : index et sources de fichiers, **caches** (`getText`), liste, **analyse** (`detectVendor`, `tokenize`, `computeFolds`), **tableau de bord** (`extractDevice`, `unitInfo`, `computeStats`, `renderDash`), **visionneuse virtualisée** (`rebuildVis`, `renderRows`, `updateViewer`), **recherche** et exports CSV, événements globaux.

Pour ajouter un constructeur, les points d'entrée sont `detectVendor()` (reconnaissance), `computeFolds()` (règles de repli) et `tokenize()` (coloration).
