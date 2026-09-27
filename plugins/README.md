# plugins

Optional plugins shipped with hncode. Each plugin is one directory:

```
plugins/
  my-plugin/
    index.js
```

A plugin is an ESM module exporting `install(api)`. See `src/plugin.js` for the full
API (tools, commands, hooks, config defaults).

```js
export function install(api) {
  api.registerCommand({ name: 'hello', description: 'Say hello', run: () => 'hi' });
}
export default { name: 'hello', version: '1.0.0' };   // optional metadata
```

Both layouts load, and the directory name is used as the plugin name when no metadata
is given:

```
~/.hncode/plugins/my-plugin/index.js    # directory — the form /plugins install writes
~/.hncode/plugins/my-plugin.js          # single file
```

Within a directory the entry point is `index.js` / `index.mjs`, or the first `.js` /
`.mjs` beside it. A directory with no loadable file is skipped rather than failing the
whole load. If a plugin needs helper modules, put them next to the entry point — the
loader imports only the entry, and it can import its neighbours normally.

## Installing one

```
/plugins                # lists loaded plugins, what is on disk, and this folder
/plugins install <name> # downloads plugins/<name>/* into ~/.hncode/plugins/<name>/
/plugins remove <name>  # deletes the local copy
```

Only loadable file types are downloaded (`.js`, `.mjs`, `.cjs`, `.json`, `.md`), so a
stray asset in a plugin directory cannot land in the plugin folder.

Plugins are loaded **once at start-up**, so after installing or removing one you must
restart hncode (`/plugins` says which ones are waiting on a restart).

## Contributing

1. Fork the repo and add `plugins/<your-plugin>/` with at least one loadable file.
2. The directory name is what users pass to `/plugins install`, so keep it to plain
   words.
3. Open a PR.

These files are **not** published to npm (see the `files` field in `package.json`);
they are fetched from this repository on demand.
