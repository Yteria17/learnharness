# Version personnelle : images, français et fiabilité

Cette version conserve la connexion ChatGPT et la synchronisation SSH automatique
pendant l’utilisation, et ajoute les contributions suivantes avec leur attribution
dans l’historique Git : PR amont #47, #55, #25, #27, #56 et la partie langue de #35.

## Captures d’écran

Collez une image depuis le presse-papiers dans l’accueil, une nouvelle séance ou
une conversation existante. Une vignette permet de la consulter en grand ou de
la retirer avant l’envoi. Une image peut être envoyée seule ou avec une légende.
Les images sauvegardées apparaissent dans l’historique et voyagent avec celui-ci
par la synchronisation SSH. Les brouillons non envoyés restent sur leur ordinateur.

Formats : PNG, JPEG, WebP et GIF. Au maximum quatre images par message, 5 Mo par
image et 10 Mo d’images au total par message. Le modèle doit accepter les images.
Pendant une réponse, les images attendent la fin de celle-ci avant l’envoi.

Les images sont désormais enregistrées séparément, une seule fois par contenu,
dans `data/attachments/`. Les conversations conservent des références et le serveur
reconstitue les messages natifs pour l’affichage et les fournisseurs. Les anciennes
captures sont migrées automatiquement lors de la synchronisation ; l’original de
chaque conversation modifiée est conservé dans `attachment-migration-backups/`.
Le format des conversations passe à v2, compris par cette version du fork.
L’export Markdown actuel n’intègre toujours pas les images.

## Bibliothèque et documents sources — 0.3.7-fork.1

L’entrée **Bibliothèque** de la barre latérale permet d’ajouter les PDF et notes,
de les télécharger et de copier une référence `library://…` dans une conversation.
Cette référence fonctionne sur Windows, macOS et Linux après synchronisation.
Les fichiers originaux ajoutés à la bibliothèque et les prochains imports de notes
sont conservés octet pour octet. Ajouter un document ne lance aucun appel de modèle.
Les formats que les agents savent analyser restent ceux de leurs outils (PDF et texte).

Les anciens imports n’avaient pas conservé leurs originaux : ajoutez ces fichiers
une fois dans la bibliothèque. Les fichiers simplement présents sur le disque ne
sont pas collectés automatiquement. Les images et documents identiques partagent
les mêmes octets, y compris entre plusieurs conversations et noms de documents.

## Synchronisation incrémentale

Le protocole SSH v2 compare des manifestes SHA-256 et ne transfère que les fichiers
modifiés, par lots bornés. Une modification de titre ne renvoie plus les PDF ou
captures inchangés. Les suppressions sont représentées dans le manifeste. Le VPS
conserve les octets une seule fois par empreinte et les nouvelles versions sous
forme de manifestes ; les historiques v1 existants sont conservés.

Limites : 50 Mio par fichier, 1 Gio pour le profil partagé, 20 000 fichiers.
Les limites des images par message restent inchangées. Les imports locaux en cours
d’utilisation sont eux aussi transmis par lots, puis publiés sous le même verrou
de révision et la même barrière d’activité qu’auparavant.

Installez **0.3.7-fork.1 sur tous les ordinateurs**. Après la première publication
v2, un ancien client est refusé explicitement pour empêcher qu’il efface la
bibliothèque qu’il ne connaît pas. Les réglages SSH et connexions ChatGPT restent
locaux et sont conservés lors de la mise à jour depuis 0.3.6.

## Français

Settings → General → Response language → Français. Le français est le choix par
défaut de ce fork ; anglais et portugais restent disponibles. Ce réglage est
synchronisé et s’applique aux prochaines réponses : cours, quiz, exercices,
corrections et contenus générés par les agents auxiliaires. Les messages existants
ne sont pas retraduits. Les menus de l’application restent dans leur langue actuelle.
Le code, les identifiants et le LaTeX ne doivent pas être traduits par les agents.

## Correctifs

- Le serveur intégré ne crée plus une deuxième icône dans le Dock macOS.
- Les versions des modèles ne sont plus tronquées dans leurs libellés.
- Les interruptions de flux et les échecs de sauvegarde produisent une erreur visible.
- Une réponse interrompue tente une reconnexion à son flux existant, sans déclencher
  une seconde génération à l’aveugle.
- Les erreurs du fournisseur restent visibles après réouverture de la conversation.
- Le tampon du proxy Next accepte l’enveloppe de synchronisation bornée à 96 Mio,
  pour éviter la troncature des profils et messages contenant des images.

Le bouton « Try again » de #35 n’est pas repris : il faisait partie d’une contribution
distincte de celle de la langue, et ses effets sur les tâches et le graphe nécessitent
un travail séparé.

## Mise à jour amont 0.3.6

Tous les changements du dépôt d’origine jusqu’au commit c549494 sont intégrés :
réduction du contexte alignée sur Pi, mesures natives du contexte et des coûts,
préservation des coûts inconnus, distinction entre IPC du serveur de développement
et connexion desktop, tests de reconnexion déterministes et version 0.3.6.

Le stockage ChatGPT suit désormais l’amont : `chatgpt-credentials.json`, dans le
profil local de l’app, est un JSON non chiffré avec les permissions du système.
L’ancien fichier `chatgpt-credentials.enc.json` est conservé mais n’est ni importé
ni déchiffré automatiquement. Une reconnexion est nécessaire sur chaque ordinateur
mis à jour depuis notre version chiffrée. Ces deux fichiers et les clés API restent
exclus des transferts SSH. Les conversations et préférences sont conservées.
