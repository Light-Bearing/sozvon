import {rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {defineConfig} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';

// Одним файлом — без распознавания лица и жестов: его модуль и модели весят
// двадцать мегабайт, а смысл этой сборки в том, чтобы её можно было просто
// передать. Переключатели в настройках в такой сборке спрятаны.
const withoutModels = () => ({
  name: 'без-моделей',
  closeBundle() {
    rmSync(resolve('dist-single/models'), {recursive: true, force: true});
  },
});

export default defineConfig({
  base: './',
  define: {'import.meta.env.VITE_VISION': JSON.stringify('нет')},
  plugins: [viteSingleFile(), withoutModels()],
  build: {target: 'es2022', outDir: 'dist-single', assetsInlineLimit: 100_000_000},
});
