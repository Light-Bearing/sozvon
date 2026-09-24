import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';

// Версия видна в настройках. Без неё нельзя отличить «исправление не
// помогло» от «исправление до тебя не доехало», а это разные беды и
// разные действия — на этом мы однажды потеряли несколько кругов.
const {version} = JSON.parse(readFileSync('./package.json', 'utf8'));

// version.json рядом со сборкой: по нему приложение узнаёт, что устарело,
// и предлагает обновиться (src/update.js). Дев-сервер отдаёт тот же ответ,
// чтобы в разработке всё вело себя так же, как на сайте.
const versionFile = () => ({
  name: 'sozvon-version',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.split('?')[0].endsWith('/version.json')) return next();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({version}));
    });
  },
  generateBundle() {
    this.emitFile({type: 'asset', fileName: 'version.json', source: JSON.stringify({version})});
  },
});

export default defineConfig({
  define: {__ВЕРСИЯ__: JSON.stringify(version)},
  plugins: [versionFile()],
  // Относительный путь обязателен: на GitHub Pages сайт лежит не в корне домена.
  base: './',
  build: {target: 'es2022'},
});
