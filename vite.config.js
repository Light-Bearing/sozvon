import {readFileSync} from 'node:fs';
import {join} from 'node:path';
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

// Среда исполнения MediaPipe — рядом со сборкой, а не с серверов Google.
// Иначе каждый, кто включит мемы или наводку на лицо, отдавал бы Google
// свой адрес ради скачивания. Берём только два варианта: с SIMD и без —
// библиотека сама выберет, какой умеет браузер. Грузится лениво, только
// когда настройку включили.
const MEDIAPIPE_DIR = 'node_modules/@mediapipe/tasks-vision/wasm';
const MEDIAPIPE_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];
const mediapipeRuntime = () => ({
  name: 'sozvon-mediapipe',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const name = req.url?.split('?')[0].match(/\/mediapipe\/([^/]+)$/)?.[1];
      if (!name || !MEDIAPIPE_FILES.includes(name)) return next();
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(readFileSync(join(MEDIAPIPE_DIR, name)));
    });
  },
  generateBundle() {
    for (const name of MEDIAPIPE_FILES) {
      this.emitFile({type: 'asset', fileName: `mediapipe/${name}`, source: readFileSync(join(MEDIAPIPE_DIR, name))});
    }
  },
});

export default defineConfig({
  define: {__ВЕРСИЯ__: JSON.stringify(version)},
  plugins: [versionFile(), mediapipeRuntime()],
  // Относительный путь обязателен: на GitHub Pages сайт лежит не в корне домена.
  base: './',
  build: {target: 'es2022'},
});
