import { cpSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const ART_SOURCE = resolve(root, 'assets');

/**
 * Serves the challenge's art from the repository root in development and copies
 * it into the bundle on build.
 *
 * The assets ship in `assets/` at the repo root (that is where the brief puts
 * them), but Vite only auto-serves `public/`. Rather than duplicate ~3 MB of art
 * or add a copy plugin dependency, this exposes the folder as a virtual public
 * path in dev and replicates it into `dist/assets` after the bundle is written.
 *
 * URLs in the manifest are therefore plain `/assets/...`, which stays correct on
 * Vercel, Netlify or a sub-path deployment.
 */
function serveRootAssets(): Plugin {
  return {
    name: 'pirate-battle:root-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/assets/')) return next();

        const relative = decodeURIComponent(url.replace(/^\/assets\//, ''));
        // Reject traversal outside the art folder.
        const target = resolve(ART_SOURCE, relative);
        if (!target.startsWith(ART_SOURCE) || !existsSync(target)) return next();

        res.setHeader('Content-Type', contentTypeFor(target));
        res.end(readFileSafe(target));
        return undefined;
      });
    },
    closeBundle() {
      if (!existsSync(ART_SOURCE)) return;
      cpSync(ART_SOURCE, resolve(root, 'dist/assets'), { recursive: true });
    },
  };
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

function readFileSafe(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch {
    // A missing or unreadable asset returns an empty body; the dev middleware
    // will let the request fall through instead of crashing the dev server.
    return Buffer.alloc(0);
  }
}

export default defineConfig({
  plugins: [react(), serveRootAssets()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 900,
  },
});
