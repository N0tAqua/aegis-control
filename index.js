/**
 * Container start file.
 *
 * Hosting panels (Wispbyte and similar) run a JavaScript file from the project
 * root, and every real entry point of this project lives in a subfolder. This
 * file boots the single-process Aegis server - API, dashboard and Discord bot -
 * defined in scripts/selfhost.mjs, so the panel can just run `index.js`.
 *
 *   PORT=12345 DISCORD_TOKEN=... node index.js
 */
import './scripts/selfhost.mjs';
