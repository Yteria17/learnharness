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

Les images sont intégrées aux fichiers de conversation, conformément à la PR amont.
Le profil synchronisé reste limité à 64 Mio : les collections d’images volumineuses
peuvent atteindre cette limite et mettre la synchronisation en attente d’une réduction
du profil. L’app affiche l’erreur ; les données locales sont conservées. Le déplacement
des images dans un stockage de pièces jointes dédié reste une évolution future.
L’export Markdown actuel n’intègre pas les images.

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
