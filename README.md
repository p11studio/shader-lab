# Shader Lab

A standalone React/Vite workspace for exploring, comparing, and tuning real-time shaders.

## Current features

- Six shader presets with editable controls.
- Independent A/B comparison.
- Save, reload, and delete local presets.
- Optional DialKit controls in development.
- Responsive workspace.
- WebGL effects built with Three.js, Paper Design shaders, and tsParticles.

This repository currently provides a standalone application. Packaging it as an installable library is planned for a later phase.

## Local development

```sh
npm install
npm run dev -- --port 5178 --strictPort
```

Open <http://127.0.0.1:5178/>.

## Production build

```sh
npm run build
npm run preview
```

## Preset storage

Saved presets use `localStorage`, scoped to the browser origin and port. Canvas A and canvas B keep independent settings.

## Attribution

The Neural Net “Light field” effect includes a personal shader generated for **@hugol** by [OpenShaders](https://openshaders.com/@hugol). OpenShaders states that generated account shaders are yours to keep and may be copied into your website. Attribution is retained in the source.

Third-party packages remain under their respective licenses; see `package.json` and `package-lock.json`.

## License

MIT — see [LICENSE](./LICENSE).
