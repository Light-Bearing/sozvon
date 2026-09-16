import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';

// Версия видна в настройках. Без неё нельзя отличить «исправление не
// помогло» от «исправление до тебя не доехало», а это разные беды и
// разные действия — на этом мы однажды потеряли несколько кругов.
const {version} = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  define: {__ВЕРСИЯ__: JSON.stringify(version)},
  // Относительный путь обязателен: на GitHub Pages сайт лежит не в корне домена.
  base: './',
  build: {target: 'es2022'},
});
