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
- Au-delà de 40 000 lignes, la coloration et le repli sont désactivés pour préserver la fluidité.

### Recherche plein texte
- Sur tout l'arbre ou seulement le dossier courant.
- Options : **regex**, **respect de la casse**, **noms de fichiers seuls**.
- Résultats **regroupés par fichier**, avec un compteur d'occurrences, des groupes repliables et un surlignage des correspondances. Un clic ouvre le fichier à la bonne ligne.
- Exports **CSV** :
  - *CSV résultats* : fichier, ligne, texte ;
  - *CSV fichiers* : fichier, nombre d'occurrences (pratique pour répondre à « quels switchs portent le VLAN 1551 ? »).
- Recherche interruptible, indicateur de progression.

### Confort
- Croix **×** dans les champs de saisie (et `Échap`) pour les vider.
- Thème clair / sombre automatique (selon le système).
- Mémorisation du dernier dossier ouvert (Chrome / Edge).

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
- Chrome / Edge refusent de sélectionner la **racine d'un lecteur** (`Z:\`) ou certains dossiers système : choisis un sous-répertoire (`Z:\configs`).
- Sur un partage réseau, la première recherche relit les fichiers via SMB et peut prendre quelques secondes.
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
- Les données restent dans le navigateur. Seuls le dernier dossier (IndexedDB) et la largeur de la colonne (localStorage) sont mémorisés.
- Le contenu des fichiers est toujours échappé avant affichage.
- Les exports CSV neutralisent les débuts de cellule pouvant être interprétés comme des formules par Excel (`=`, `+`, `-`, `@`).
- Les configs contiennent souvent des secrets (communautés SNMP, mots de passe, clés RADIUS) : pense-y avant de partager une capture ou un export.

## Structure

```
config_browser/
├── index.html   # structure de la page
├── style.css    # thème clair/sombre, coloration, sections repliables, résultats
└── app.js       # sources de fichiers, analyse, coloration, repli, recherche, CSV
```

Dans `app.js`, les grandes parties sont, dans l'ordre : index et sources de fichiers, liste, lecture, **analyse** (`detectVendor`, `tokenize`, `computeFolds`), visionneuse, **recherche** et exports CSV, événements globaux.

Pour ajouter un constructeur, les points d'entrée sont `detectVendor()` (reconnaissance), `computeFolds()` (règles de repli) et `tokenize()` (coloration).
