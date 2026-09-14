import {defineConfig} from 'vite';

export default defineConfig({
  // Относительный путь обязателен: на GitHub Pages сайт лежит не в корне домена.
  base: './',
  build: {target: 'es2022'},
});
